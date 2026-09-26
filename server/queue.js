const { Queue, Worker } = require('bullmq');
const { Order } = require('./models/db');

// ตั้งค่า Redis Connection (ใช้พอร์ตมาตรฐานของ Redis)
const connection = { host: 'localhost', port: 6379 };

// สร้างคิวสำหรับโพยหวย
const betQueue = new Queue('bet-queue', { connection });

// สร้าง Worker คอยประมวลผลโพยทีละรายการอย่างเป็นระเบียบ (High Performance)
const worker = new Worker('bet-queue', async (job) => {
    const orderData = job.data;
    
    // บันทึกลง MongoDB จริง
    const newOrder = new Order(orderData);
    await newOrder.save();
    
    return { status: 'success', orderId: newOrder._id };
}, { connection });

worker.on('completed', (job) => {
    console.log(`Processed bet job ${job.id} successfully.`);
});

worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed:`, err);
});

module.exports = { betQueue };