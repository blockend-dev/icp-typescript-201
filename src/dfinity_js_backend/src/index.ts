import {
	query,
	update,
	text,
	Record,
	StableBTreeMap,
	Variant,
	Vec,
	None,
	Some,
	Ok,
	Err,
	ic,
	Principal,
	Opt,
	nat64,
	int32,
	Duration,
	Result,
	bool,
	Canister,
	blob,
	init,
} from 'azle';
import { Ledger, binaryAddressFromPrincipal, hexAddressFromPrincipal } from 'azle/canisters/ledger';
//@ts-ignore
import { hashCode } from 'hashcode';
import { v4 as uuidv4 } from 'uuid';

const Document = Record({
	id: text,
	name: text,
	hash: blob,
	createdAt: nat64,
	owner: Principal,
});

const Task = Record({
	id: text,
	name: text,
	description: text,
	status: text, // pending, completed
	createdAt: nat64,
	dueDate: Opt(nat64),
	owner: Principal,
});

const AddTaskPayload = Record({
	name: text,
	description: text,
	dueDate: Opt(nat64),
});

const UpdateTaskPayload = Record({
	name: Opt(text),
	description: Opt(text),
	dueDate: Opt(Opt(nat64)), // Optional update for dueDate (None for no change)
});

const InitPayload = Record({
	addDocFee: nat64,
	verifyDocFee: nat64,
	addTaskFee: nat64,
});

let nextDocId: Opt<int32> = None;
let addDocFee: Opt<nat64> = None;
let verifyDocFee: Opt<nat64> = None;
let addTaskFee: Opt<nat64> = None;

const PaymentStatus = Variant({
	PaymentPending: text,
	Completed: text,
});

const PaymentOrder = Record({
	orderId: text,
	fee: nat64,
	status: PaymentStatus,
	payer: Principal,
	paid_at_block: Opt(nat64),
	memo: nat64,
});

const Message = Variant({
	Exists: text,
	NotFound: text,
	InvalidPayload: text,
	PaymentFailed: text,
	PaymentCompleted: text,
	Success: text,
	Fail: text,
});

// id to task hash storage
const id2TaskStorage = StableBTreeMap(0, text, Task);

// user to task mapping
const userTaskMap = StableBTreeMap(2, Principal, Vec(text));

const persistedOrders = StableBTreeMap(1, Principal, PaymentOrder);
const pendingOrders = StableBTreeMap(2, nat64, PaymentOrder);

const ORDER_RESERVATION_PERIOD = 120n; // reservation period in seconds

/* 
  initialization of the Ledger canister. The principal text value is hardcoded because 
  we set it in the `dfx.json`
*/
const icpCanister = Ledger(Principal.fromText('ryjl3-tyaaa-aaaaa-aaaba-cai'));

export default Canister({
	init: init([InitPayload], (payload) => {
		// check payload data
		if (payload.addDocFee < 0 || payload.verifyDocFee < 0 || payload.addTaskFee < 0) {
			ic.trap('fees must be greater than 0 ICP');
		}

		// set data
		addDocFee = Some(payload.addDocFee);
		verifyDocFee = Some(payload.verifyDocFee);
		addTaskFee = Some(payload.addTaskFee);
		nextDocId = Some(0);
	}),

	// similar to createDocumentOrder, handles payment for creating a task
	createTaskOrder: update([], Result(PaymentOrder, Message), () => {
		let orderId = uuidv4();

		if ('None' in addTaskFee) {
			return Err({ NotFound: 'add task fee not set' });
		}

		const paymentOrder = {
			orderId,
			fee: addTaskFee.Some,
			status: { PaymentPending: 'PAYMENT_PENDING' },
			payer: ic.caller(),
			paid_at_block: None,
			memo: generateCorrelationId(orderId),
		};

		// store and return order
		pendingOrders.insert(paymentOrder.memo, paymentOrder);
		discardByTimeout(paymentOrder.memo, ORDER_RESERVATION_PERIOD);
		return Ok(paymentOrder);
	}),

	addTask: update(
		[AddTaskPayload, text, nat64, nat64],
		Result(Message, Message),
		async (payload, paymentId, block, memo) => {
			const caller = ic.caller();

			// check that fees are set
			if ('None' in addTaskFee) {
				return Err({ NotFound: 'add task fee not set' });
			}

			// verify payment and fail if payment not found
			const paymentVerified = await verifyPaymentInternal(
				caller,
				addTaskFee.Some,
				block,
				memo
			);
			if (!paymentVerified) {
				return Err({
					NotFound: `cannot complete the payment: cannot verify the payment, memo=${memo}`,
				});
			}

			// update order record from pending to persisted
			const pendingOrderOpt = pendingOrders.remove(memo);
			if ('None' in pendingOrderOpt) {
				return Err({
					NotFound: `cannot complete the payment: there is no pending order with id=${paymentId}`,
				});
			}
			const order = pendingOrderOpt.Some;
			const updatedOrder = {
				...order,
				status: { Completed: 'COMPLETED' },
				paid_at_block: Some(block),
			};

			// create task object with default status as "pending"
			const newTask = {
				id: uuidv4(),
				name: payload.name,
				description: payload.description,
				status: 'pending',
				createdAt: ic.time(),
				dueDate: payload.dueDate,
				owner: caller,
			};

			// update records
			id2TaskStorage.insert(newTask.id, newTask);

			// get user task map and update
			let userTasksOpt = userTaskMap.get(caller);
			if ('None' in userTasksOpt) {
				let newMap: Vec<text> = [newTask.id];
				userTaskMap.insert(caller, newMap);
			} else {
				let updatedMap = [...userTasksOpt.Some, newTask.id];
				userTaskMap.insert(caller, updatedMap);
			}

			persistedOrders.insert(ic.caller(), updatedOrder);

			return Ok({ Success: `task with id ${newTask.id} added` });
		}
	),

	// similar to completeDocument, marks a task as completed
	completeTask: update([text], Result(Message, Message), (taskId) => {
		const caller = ic.caller();

		// get task data
		const taskOpt = id2TaskStorage.get(taskId);

		if ('None' in taskOpt) {
			return Err({ NotFound: 'task not found' });
		}

		const task = taskOpt.Some;

		// check ownership
		if (task.owner !== caller) {
			return Err({ NotFound: 'you are not authorized to modify this task' });
		}

		// update task status
		task.status = 'completed';
		id2TaskStorage.insert(taskId, task);

		return Ok({ Success: `task with id ${taskId} completed` });
	}),

	getUserTasks: query([Principal], Vec(text), (user) => {
		let userTasksOpt = userTaskMap.get(user);
		// check if list is empty
		if ('None' in userTasksOpt) {
			return [];
		}
		return userTasksOpt.Some;
	}),

	// allows task owners to view their task details
	viewTask: query([Principal, text], Result(Task, Message), (user, taskId) => {
		// get user tasks
		let userTasksOpt = userTaskMap.get(user);

		// check if list is empty
		if ('None' in userTasksOpt) {
			return Err({ NotFound: 'you do not have access to this task' });
		}

		let userTasks = userTasksOpt.Some;

		// check if list contains specified task id
		if (!userTasks.includes(taskId)) {
			return Err({ NotFound: 'you do not have access to this task' });
		
		// get task data
		const taskOpt = id2TaskStorage.get(taskId);

		if ('None' in taskOpt) {
			return Err({ NotFound: 'task not found' });
		}

		return Ok(taskOpt.Some);
	}),

	// update specific task fields (name, description, or dueDate)
	updateTask: update(
		[text, UpdateTaskPayload],
		Result(Message, Message),
		(taskId, updatePayload) => {
			const caller = ic.caller();

			// get task data
			const taskOpt = id2TaskStorage.get(taskId);

			if ('None' in taskOpt) {
				return Err({ NotFound: 'task not found' });
			}

			const task = taskOpt.Some;

			// check ownership
			if (task.owner !== caller) {
				return Err({ NotFound: 'you are not authorized to modify this task' });
			}

			// update task fields based on payload
			task.name = updatePayload.name.getOrElse(task.name);
			task.description = updatePayload.description.getOrElse(task.description);
			if ('Some' in updatePayload.dueDate) {
				// update dueDate only if provided in payload (None for no change)
				task.dueDate = updatePayload.dueDate.Some;
			}

			// update task storage
			id2TaskStorage.insert(taskId, task);

			return Ok({ Success: `task with id ${taskId} updated` });
		}
	),

	// delete a task
	deleteTask: update([text], Result(Message, Message), (taskId) => {
		const caller = ic.caller();

		// get task data
		const taskOpt = id2TaskStorage.get(taskId);

		if ('None' in taskOpt) {
			return Err({ NotFound: 'task not found' });
		}

		const task = taskOpt.Some;

		// check ownership
		if (task.owner !== caller) {
			return Err({ NotFound: 'you are not authorized to delete this task' });
		}

		// remove task from user task map
		let userTasksOpt = userTaskMap.get(caller);

		if ('None' in userTasksOpt) {
			return Err({ NotFound: 'unexpected error: user task map not found' });
		}

		let userTasks = userTasksOpt.Some;
		const taskIndex = userTasks.indexOf(taskId);

		if (taskIndex > -1) {
			userTasks.splice(taskIndex, 1);
		} else {
			return Err({ NotFound: 'task not found in user list' });
		}

		userTaskMap.insert(caller, userTasks);

		// remove task from storage
		id2TaskStorage.delete(taskId);

		return Ok({ Success: 'task deleted successfully' });
	}),

	// ... remaining helper functions (getCanisterAddress, getAddressFromPrincipal, etc.)
});
/*
    a hash function that is used to generate correlation ids for orders.
    also, we use that in the verifyPayment function where we check if the used has actually paid the order
*/
function hash(input: any): nat64 {
	return BigInt(Math.abs(hashCode().value(input)));
}

// a workaround to make uuid package work with Azle
globalThis.crypto = {
	// @ts-ignore
	getRandomValues: () => {
		let array = new Uint8Array(32);

		for (let i = 0; i < array.length; i++) {
			array[i] = Math.floor(Math.random() * 256);
		}

		return array;
	},
};

function generateCorrelationId(productId: text): nat64 {
	const correlationId = `${productId}_${ic.caller().toText()}_${ic.time()}`;
	return hash(correlationId);
}

/*
    after the order is created, we give the `delay` amount of minutes to pay for the order.
    if it's not paid during this timeframe, the order is automatically removed from the pending orders.
*/
function discardByTimeout(memo: nat64, delay: Duration) {
	ic.setTimer(delay, () => {
		const order = pendingOrders.remove(memo);
		console.log(`Order discarded ${order}`);
	});
}

async function verifyPaymentInternal(
	caller: Principal,
	amount: nat64,
	block: nat64,
	memo: nat64
): Promise<bool> {
	const blockData = await ic.call(icpCanister.query_blocks, {
		args: [{ start: block, length: 1n }],
	});
	const tx = blockData.blocks.find((block) => {
		if ('None' in block.transaction.operation) {
			return false;
		}
		const operation = block.transaction.operation.Some;
		const senderAddress = binaryAddressFromPrincipal(caller, 0);
		const receiverAddress = binaryAddressFromPrincipal(ic.id(), 0);
		return (
			block.transaction.memo === memo &&
			hash(senderAddress) === hash(operation.Transfer?.from) &&
			hash(receiverAddress) === hash(operation.Transfer?.to) &&
			amount === operation.Transfer?.amount.e8s
		);
	});
	return tx ? true : false;
}

