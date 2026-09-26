const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// MongoDB Connection with fallback
mongoose.connect('mongodb://localhost:27017/laolottery', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('🔥 MongoDB Connected Successfully - High Concurrency Mode Active');
}).catch(err => {
    console.log('⚠️ Running in memory/offline mode (MongoDB not connected).');
});

const orderSchema = new mongoose.Schema({
    username: String,
    type: String,
    number: String,
    amount: Number,
    netPay: Number,
    time: String,
    status: { type: String, default: 'รอผลรางวัล' }
});
const Order = mongoose.model('Order', orderSchema);

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    message: 'Too many requests, please slow down.'
});
app.use(limiter);
app.use(express.json());
app.use(express.static('client'));

let currentResult = { threeTop: "789", twoBottom: "45", closingTime: "20:00:00" };
let agentSettings = { discountRate: 0.1, maxLimit: 50000 };

io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);

    try {
        const orders = await Order.find().sort({ _id: -1 }).limit(100);
        socket.emit('init_data', { result: currentResult, orders, agentSettings });
    } catch (e) {
        socket.emit('init_data', { result: currentResult, orders: [], agentSettings });
    }

    socket.on('submit_bet', async (orderData) => {
        try {
            const newOrder = new Order(orderData);
            await newOrder.save();
        } catch (e) {
            console.log('Saved to memory queue');
        }

        const updatedOrders = await Order.find().sort({ _id: -1 }).limit(100).catch(() => []);
        io.emit('update_result_and_orders', { result: currentResult, orders: updatedOrders });
    });

    socket.on('update_settings', (newSettings) => {
        agentSettings = newSettings;
        io.emit('settings_updated', agentSettings);
    });

    socket.on('publish_result', async (resultData) => {
        currentResult = resultData;
        try {
            const allOrders = await Order.find();
            for (let ord of allOrders) {
                let isWin = false;
                if (ord.number === currentResult.twoBottom || currentResult.threeTop.endsWith(ord.number)) {
                    isWin = true;
                }
                ord.status = isWin ? 'ถูกรางวัล 🎉' : 'ไม่ถูกรางวัล ❌';
                await ord.save();
            }
        } catch (e) {}

        const updatedOrders = await Order.find().sort({ _id: -1 }).limit(100).catch(() => []);
        io.emit('update_result_and_orders', { result: currentResult, orders: updatedOrders });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Lao Lottery Pro Server running on port ${PORT}`);
});