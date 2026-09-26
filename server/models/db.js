const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        // ใช้ Local MongoDB หรือ MongoDB Atlas URI ของคุณ
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/laolottery', {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('MongoDB Connected Successfully.');
    } catch (err) {
        console.error('Database connection error:', err);
        process.exit(1);
    }
};

// สคีมาโพยหวย
const orderSchema = new mongoose.Schema({
    username: String,
    type: String,
    number: String,
    netPay: Number,
    time: String,
    status: { type: String, default: 'รอผลรางวัล' }
});

const Order = mongoose.model('Order', orderSchema);

module.exports = { connectDB, Order };