const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/lottery_production';

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    credit: { type: Number, default: 0 },
    role: { type: String, default: 'member' },
    discountRate: { type: Number, default: 0.10 }
});
const User = mongoose.model('User', userSchema);

async function run() {
    await mongoose.connect(MONGO_URI);
    
    // ตั้งค่า รหัสผ่านแอดมินคนแรก
    const hashedPassword = await bcrypt.hash('admin1234', 10);
    
    await User.updateOne(
        { username: 'admin_agent' },
        { password: 1234, credit: 1000000, role: 'agent' },
        { upsert: true }
    );
    
    console.log('✅ สร้างบัญชีแอดมินเรียบร้อย:');
    console.log('   Username: admin_agent');
    console.log('   Password: admin1234');
    process.exit(0);
}

run().catch(console.error);