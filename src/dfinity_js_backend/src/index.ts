import {
  query,
  update,
  text,
  Record,
  StableBTreeMap,
  Vec,
  Opt,
  Principal,
  nat64,
  Result,
  Canister,
  init,
  Duration,
  blob,
  hash,
} from 'azle';
import { v4 as uuidv4 } from 'uuid';

// Define the Document record type
const Document = Record({
  id: text,
  name: text,
  hash: blob,
  createdAt: nat64,
  owner: Principal,
});

// Define the Task record type
const Task = Record({
  id: text,
  name: text,
  description: text,
  status: text, // pending, completed
  createdAt: nat64,
  dueDate: Opt(nat64),
  owner: Principal,
});

// Define the payload for adding a task
const AddTaskPayload = Record({
  name: text,
  description: text,
  dueDate: Opt(nat64),
});

// Define the payload for updating a task
const UpdateTaskPayload = Record({
  name: Opt(text),
  description: Opt(text),
  dueDate: Opt(Opt(nat64)), // Optional update for dueDate (None for no change)
});

// Define the payload for initialization
const InitPayload = Record({
  addDocFee: nat64,
  verifyDocFee: nat64,
  addTaskFee: nat64,
});

// Define the PaymentStatus variant
const PaymentStatus = Record({
  PaymentPending: text,
  Completed: text,
});

// Define the PaymentOrder record type
const PaymentOrder = Record({
  orderId: text,
  fee: nat64,
  status: PaymentStatus,
  payer: Principal,
  paidAtBlock: Opt(nat64),
  memo: nat64,
});

// Define the Message variant
const Message = Record({
  Exists: text,
  NotFound: text,
  InvalidPayload: text,
  PaymentFailed: text,
  PaymentCompleted: text,
  Success: text,
  Fail: text,
});

// Define the storage for task IDs
const id2TaskStorage = StableBTreeMap(0, text, Task);

// Define the mapping of user to tasks
const userTaskMap = StableBTreeMap(2, Principal, Vec(text));

// Define the mapping of persisted orders
const persistedOrders = StableBTreeMap(1, Principal, PaymentOrder);

// Define the mapping of pending orders
const pendingOrders = StableBTreeMap(2, nat64, PaymentOrder);

// Define the order reservation period
const ORDER_RESERVATION_PERIOD: Duration = 120n; // reservation period in seconds

// Define the Ledger Canister
const icpCanister = Canister('ryjl3-tyaaa-aaaaa-aaaba-cai');

// Initialize the Canister
export default Canister({
  init: init([InitPayload], (payload) => {
    // Check payload data
    if (payload.addDocFee < 0 || payload.verifyDocFee < 0 || payload.addTaskFee < 0) {
      throw new Error('Fees must be greater than 0 ICP');
    }

    // Set data
    addDocFee = Some(payload.addDocFee);
    verifyDocFee = Some(payload.verifyDocFee);
    addTaskFee = Some(payload.addTaskFee);
    nextDocId = Some(0);
  }),

  // Create a task order
  createTaskOrder: update([], Result(PaymentOrder, Message), () => {
    const orderId = uuidv4();

    if (addTaskFee === None) {
      return Err({ NotFound: 'Add task fee not set' });
    }

    const paymentOrder: PaymentOrder = {
      orderId,
      fee: addTaskFee.unwrap(),
      status: { PaymentPending: 'PAYMENT_PENDING' },
      payer: ic.caller(),
      paidAtBlock: None,
      memo: generateCorrelationId(orderId),
    };

    // Store and return order
    pendingOrders.insert(paymentOrder.memo, paymentOrder);
    discardByTimeout(paymentOrder.memo, ORDER_RESERVATION_PERIOD);
    return Ok(paymentOrder);
  }),

  // Add a task
  addTask: update(
    [AddTaskPayload, text, nat64, nat64],
    Result(Message, Message),
    async (payload, paymentId, block, memo) => {
      const caller = ic.caller();

      // Check that fees are set
      if (addTaskFee === None) {
        return Err({ NotFound: 'Add task fee not set' });
      }

      // Verify payment and fail if payment not found
      const paymentVerified = await verifyPaymentInternal(
        caller,
        addTaskFee.unwrap(),
        block,
        memo
      );

      if (!paymentVerified) {
        return Err({
          NotFound: `Cannot complete the payment: cannot verify the payment, memo=${memo}`,
        });
      }

      // Update order record from pending to persisted
      const pendingOrderOpt = pendingOrders.remove(memo);

      if (pendingOrderOpt === None) {
        return Err({
          NotFound: `Cannot complete the payment: there is no pending order with id=${paymentId}`,
        });
      }

      const order = pendingOrderOpt.unwrap();
      const updatedOrder: PaymentOrder = {
        ...order,
        status: { Completed: 'COMPLETED' },
        paidAtBlock: Some(block),
      };

      // Create task object with default status as "pending"
      const newTask: Task = {
        id: uuidv4(),
        name: payload.name,
        description: payload.description,
        status: 'pending',
        createdAt: ic.time(),
        dueDate: payload.dueDate,
        owner: caller,
      };

      // Update records
      id2TaskStorage.insert(newTask.id, newTask);

      // Get user task map and update
      let userTasksOpt = userTaskMap.get(caller);

      if (userTasksOpt === None) {
        userTaskMap.insert(caller, [newTask.id]);
      } else {
        const updatedMap = [...userTasksOpt.unwrap(), newTask.id];
        userTaskMap.insert(caller, updatedMap);
      }

      persistedOrders.insert(ic.caller(), updatedOrder);

      return Ok({ Success: `Task with id ${newTask.id} added` });
    }
  ),

  // Complete a task
  completeTask: update([text], Result(Message, Message), (taskId) => {
    const caller = ic.caller();

    // Get task data
    const taskOpt = id2TaskStorage.get(taskId);

    if (taskOpt === None) {
      return Err({ NotFound: 'Task not found' });
    }

    const task = taskOpt.unwrap();

    // Check ownership
    if (task.owner !== caller) {
      return Err({ NotFound: 'You are not authorized to modify this task' });
    }

    // Update task status
    task.status = 'completed';
    id2TaskStorage.insert(taskId, task);

    return Ok({ Success: `Task with id ${taskId} completed` });
  }),

  // Get user tasks
  getUserTasks: query([Principal], Vec(text), (user) => {
    const userTasksOpt = userTaskMap.get(user);

    // Check if list is empty
    if (userTasksOpt === None) {
      return [];
    }

    return userTasksOpt.unwrap();
  }),

  // View task
  viewTask: query([Principal, text], Result(Task, Message), (user, taskId) => {
    // Get user tasks
    const userTasksOpt = userTaskMap.get(user);

    // Check if list is empty
    if (userTasksOpt === None || !userTasksOpt.unwrap().includes(taskId)) {
      return Err({ NotFound: 'You do not have access to this task' });
    }

    // Get task data
    const taskOpt = id2TaskStorage.get(taskId);

    if (taskOpt === None) {
      return Err({ NotFound: 'Task not found' });
    }

    return Ok(taskOpt.unwrap());
  }),

  // Update task
  updateTask: update(
    [text, UpdateTaskPayload],
    Result(Message, Message),
    (taskId, updatePayload) => {
      const caller = ic.caller();

      // Get task data
      const taskOpt = id2TaskStorage.get(taskId);

      if (taskOpt === None) {
        return Err({ NotFound: 'Task not found' });
      }

      const task = taskOpt.unwrap();

      // Check ownership
      if (task.owner !== caller) {
        return Err({ NotFound: 'You are not authorized to modify this task' });
      }

      // Update task fields based on payload
      task.name = updatePayload.name.getOrElse(task.name);
      task.description = updatePayload.description.getOrElse(task.description);

      if (updatePayload.dueDate.isSome()) {
        // Update dueDate only if provided in payload (None for no change)
        task.dueDate = updatePayload.dueDate.unwrap();
      }

      // Update task storage
      id2TaskStorage.insert(taskId, task);

      return Ok({ Success: `Task with id ${taskId} updated` });
    }
  ),

  // Delete a task
  deleteTask: update([text], Result(Message, Message), (taskId) => {
    const caller = ic.caller();

    // Get task data
    const taskOpt = id2TaskStorage.get(taskId);

    if (taskOpt === None) {
      return Err({ NotFound: 'Task not found' });
    }

    const task = taskOpt.unwrap();

    // Check ownership
    if (task.owner !== caller) {
      return Err({ NotFound: 'You are not authorized to delete this task' });
    }

    // Remove task from user task map
    const userTasksOpt = userTaskMap.get(caller);

    if (userTasksOpt === None) {
      return Err({ NotFound: 'Unexpected error: user task map not found' });
    }

    const userTasks = userTasksOpt.unwrap();
    const taskIndex = userTasks.indexOf(taskId);

    if (taskIndex > -1) {
      userTasks.splice(taskIndex, 1);
    } else {
      return Err({ NotFound: 'Task not found in user list' });
    }

    userTaskMap.insert(caller, userTasks);

    // Remove task from storage
    id2TaskStorage.delete(taskId);

    return Ok({ Success: 'Task deleted successfully' });
  }),

  // Remaining helper functions (getCanisterAddress, getAddressFromPrincipal, etc.)
});

// Generate a correlation ID for orders
function generateCorrelationId(productId: text): nat64 {
  const correlationId = `${productId}_${ic.caller().toText()}_${ic.time()}`;
  return hash(correlationId);
}

// Discard orders by timeout
function discardByTimeout(memo: nat64, delay: Duration) {
  ic.setTimer(delay, () => {
    const order = pendingOrders.remove(memo);
    console.log(`Order discarded ${order}`);
  });
}

// Verify payment internally
async function verifyPaymentInternal(
  caller: Principal,
  amount: nat64,
  block: nat64,
  memo: nat64
): Promise<boolean> {
  const blockData = await ic.call(icpCanister.query_blocks, {
    args: [{ start: block, length: 1n }],
  });

  const tx = blockData.blocks.find((block) => {
    if ('None' in block.transaction.operation) {
      return false;
    }

    const operation = block.transaction.operation.unwrap();

    const senderAddress = hash(binaryAddressFromPrincipal(caller, 0));
    const receiverAddress = hash(binaryAddressFromPrincipal(ic.id(), 0));

    return (
      block.transaction.memo === memo &&
      senderAddress === hash(operation.Transfer?.from) &&
      receiverAddress === hash(operation.Transfer?.to) &&
      amount === operation.Transfer?.amount.e8s
    );
  });

  return !!tx;
}
