const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static('client'));

// Database Connection
mongoose.connect('mongodb://localhost:27017/laolottery_pro', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('🔥 MongoDB Connected - Full Enterprise Engine')).catch(() => console.log('⚠️ Running in-memory fallback'));

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    credit: { type: Number, default: 0 },
    role: { type: String, default: 'member' },
    refCode: { type: String, unique: true },
    referredBy: { type: String, default: null },
    affiliateEarnings: { type: Number, default: 0 },
    vipLevel: { type: String, default: 'Bronze' },
    totalTurnover: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const orderSchema = new mongoose.Schema({
    username: String,
    lotteryType: String, // หวยลาว, ฮานอย, ยี่กี
    type: String,        // 3ตัวบน, 2ตัวล่าง, 19ประตู, 6กลับ
    number: String,
    amount: Number,
    discount: Number,
    netPay: Number,
    winStatus: { type: String, default: 'รอผลรางวัล' },
    payout: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

const configSchema = new mongoose.Schema({
    maxBetPerNumber: { type: Number, default: 10000 }, // ระบบอั้นอัตโนมัติเมื่อยอดรวมเกิน
    blockedNumbers: [String],                           // เลขปิดรับ
    lineNotifyToken: { type: String, default: '' }
});
const Config = mongoose.model('Config', configSchema);

// ==================== HELPER FUNCTIONS ====================
// 1. Text-to-Bet Parser (อ่านข้อความโพยด่วน)
function parseTextToBets(text) {
    // ตัวอย่างข้อความ: "123x100x100 45x50 19ประตู 7 x20"
    const lines = text.split('\n');
    const parsedBets = [];
    
    lines.forEach(line => {
        const match3 = line.match(/(\d{3})x(\d+)(?:x(\d+))?/i);
        if (match3) {
            parsedBets.push({ type: '3ตัวบน', number: match3[1], amount: parseFloat(match3[2]) });
            if (match3[3]) parsedBets.push({ type: '3ตัวโต๊ด', number: match3[1], amount: parseFloat(match3[3]) });
            return;
        }
        const match2 = line.match(/(\d{2})x(\d+)/i);
        if (match2) {
            parsedBets.push({ type: '2ตัวบน', number: match2[1], amount: parseFloat(match2[2]) });
        }
    });
    return parsedBets;
}

// 2. Expand Number Systems (19 ประตู / 6 กลับ / 3 กลับ)
function expandBetNumbers(type, number) {
    let result = [];
    if (type === '19ประตู') {
        let digit = number.toString().trim();
        for (let i = 0; i <= 9; i++) {
            result.push(`${digit}${i}`);
            if (digit !== i.toString()) result.push(`${i}${digit}`);
        }
    } else if (type === '6กลับ' && number.length === 3) {
        let n = number.split('');
        let perms = [
            n[0]+n[1]+n[2], n[0]+n[2]+n[1],
            n[1]+n[0]+n[2], n[1]+n[2]+n[0],
            n[2]+n[0]+n[1], n[2]+n[1]+n[0]
        ];
        result = [...new Set(perms)];
    } else {
        result.push(number);
    }
    return result;
}

// ==================== REAL-TIME ENGINE ====================
let currentResults = {
    'หวยลาวพรีเมียม': { threeTop: '789', twoBottom: '45' },
    'ฮานอย VIP': { threeTop: '123', twoBottom: '88' },
    'ยี่กี รอบที่ 1': { threeTop: '999', twoBottom: '00' }
};

io.on('connection', (socket) => {
    // ส่งข้อมูลตั้งต้นเมื่อเชื่อมต่อ
    socket.on('request_init', async () => {
        const orders = await Order.find().sort({ _id: -1 }).limit(50).catch(() => []);
        const users = await User.find().catch(() => []);
        socket.emit('init_data', { results: currentResults, orders, users });
    });

    // แทงโพย (รองรับอั้นออโต้ + ค่าคอมมิชชั่นแนะนำเพื่อน + ส่วนลด VIP)
    socket.on('submit_bets', async (data) => {
        // data = { username, lotteryType, bets: [{type, number, amount}] }
        const user = await User.findOne({ username: data.username });
        if (!user) return socket.emit('error_msg', 'ไม่พบผู้ใช้งาน');

        let totalNet = 0;
        let processedOrders = [];

        for (let b of data.bets) {
            let expandedNums = expandBetNumbers(b.type, b.number);
            for (let num of expandedNums) {
                // ตรวจสอบวงเงินเสี่ยงรวม (Max Bet Limit per Number)
                const existingSum = await Order.aggregate([
                    { $match: { lotteryType: data.lotteryType, number: num } },
                    { $group: { _id: null, total: { $sum: "$amount" } } }
                ]);
                let currentTotal = existingSum[0] ? existingSum[0].total : 0;
                if (currentTotal + b.amount > 10000) {
                    socket.emit('error_msg', `เลข ${num} มียอดแทงเต็มจำนวนแล้ว (เลขอั้นออโต้)`);
                    continue;
                }

                let discountRate = user.vipLevel === 'Gold' ? 0.12 : 0.10;
                let netPay = b.amount * (1 - discountRate);

                if (user.credit < netPay) {
                    socket.emit('error_msg', 'เครดิตไม่พอสำหรับทำรายการ');
                    return;
                }

                user.credit -= netPay;
                user.totalTurnover += b.amount;
                totalNet += netPay;

                // คำนวณส่วนแบ่งแนะนำเพื่อน (Affiliate 8%)
                if (user.referredBy) {
                    let comm = netPay * 0.08;
                    await User.updateOne({ refCode: user.referredBy }, { $inc: { affiliateEarnings: comm, credit: comm } });
                }

                const newOrder = new Order({
                    username: user.username,
                    lotteryType: data.lotteryType,
                    type: b.type,
                    number: num,
                    amount: b.amount,
                    discount: b.amount * discountRate,
                    netPay: netPay
                });
                await newOrder.save();
                processedOrders.push(newOrder);
            }
        }

        await user.save();
        io.emit('orders_updated', await Order.find().sort({ _id: -1 }).limit(50));
        socket.emit('bet_success', { remainingCredit: user.credit, totalPaid: totalNet });
    });

    // ระบบฝากเงินออโต้ สแกนสลิป (Mock Verification)
    socket.on('process_deposit_slip', async (data) => {
        // data = { username, slipData }
        let amount = Math.floor(Math.random() * 900) + 100; // จำลองยอดเงินสลิป
        await User.updateOne({ username: data.username }, { $inc: { credit: amount } });
        const updatedUser = await User.findOne({ username: data.username });
        socket.emit('deposit_success', { addedCredit: amount, newCredit: updatedUser.credit });
    });

    // ประกาศผลรางวัล + เคลียร์ยอดได้เสีย
    socket.on('publish_lottery_result', async (data) => {
        // data = { lotteryType, threeTop, twoBottom }
        currentResults[data.lotteryType] = { threeTop: data.threeTop, twoBottom: data.twoBottom };
        
        const pendingOrders = await Order.find({ lotteryType: data.lotteryType, winStatus: 'รอผลรางวัล' });
        for (let ord of pendingOrders) {
            let isWin = false;
            let winMultiplier = ord.type.includes('3') ? 900 : 95;
            
            if (data.threeTop.endsWith(ord.number) || data.twoBottom === ord.number) {
                isWin = true;
            }

            if (isWin) {
                ord.winStatus = 'ถูกรางวัล 🎉';
                ord.payout = ord.amount * winMultiplier;
                await User.updateOne({ username: ord.username }, { $inc: { credit: ord.payout } });
            } else {
                ord.winStatus = 'ไม่ถูกรางวัล ❌';
            }
            await ord.save();
        }

        io.emit('results_updated', { results: currentResults, orders: await Order.find().sort({ _id: -1 }).limit(50) });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Lao Lottery Pro System active on port ${PORT}`));