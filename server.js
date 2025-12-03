const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fileUpload = require('express-fileupload');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'richmore-secret-key-2023';
const MONTHLY_PAYMENT = 12000;
const PENALTY_RATE = 2;
const REFERRAL_BONUS_PERCENTAGE = 5;

const initDirectories = async () => {
  const directories = [
    path.join(__dirname, 'data'),
    path.join(__dirname, 'uploads'),
    path.join(__dirname, 'public', 'user'),
    path.join(__dirname, 'public', 'admin')
  ];

  for (const dir of directories) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Directory created: ${dir}`);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error(`Error creating directory ${dir}:`, err);
      }
    }
  }
};

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/data', express.static(path.join(__dirname, 'data')));

async function readJsonFile(filename) {
  const defaultData = {
    'users.json': [],
    'transactions.json': [],
    'savings_plans.json': [],
    'withdrawals.json': [],
    'receipts.json': [],
    'notifications.json': [],
    'config.json': {
      companyBankDetails: {
        bankName: "RichMore Savings Bank",
        accountNumber: "1234567890",
        accountName: "RichMore Now Ltd"
      },
      monthlyPaymentAmount: 12000,
      withdrawalProcessingFee: 500,
      penaltyMultiplier: 2,
      paymentReminderDays: 3,
      appSettings: {
        minPasswordLength: 6,
        maxLoginAttempts: 5
      }
    }
  };

  try {
    const filePath = path.join(__dirname, 'data', filename);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultData[filename] || [];
    }
    throw err;
  }
}

async function writeJsonFile(filename, data) {
  const filePath = path.join(__dirname, 'data', filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  emitFileUpdate(filename, data);
}

function generateToken(user) {
  return crypto.createHash('sha256')
    .update(`${user.id}${user.email}${SECRET_KEY}`)
    .digest('hex');
}

function generateReferralCode(firstName) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let randomPart = '';
  for (let i = 0; i < 6; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const prefix = firstName.toUpperCase().substring(0, 4);
  return `${prefix}-${randomPart}`;
}

async function saveBase64Image(base64Data, userId) {
  try {
    const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Invalid base64 image data');
    }

    const imageType = matches[1];
    const imageData = matches[2];
    const buffer = Buffer.from(imageData, 'base64');
    const filename = `receipt-${userId}-${Date.now()}.${imageType}`;
    const filePath = path.join(__dirname, 'uploads', filename);

    await fs.writeFile(filePath, buffer);
    return filename;
  } catch (error) {
    console.error('Error saving image:', error);
    throw error;
  }
}

function calculateNextPayment(user, lastPaymentDate) {
  const now = new Date();
  const lastPayment = new Date(lastPaymentDate);
  
  const daysSinceLastPayment = Math.floor((now - lastPayment) / (1000 * 60 * 60 * 24));
  const isOverdue = daysSinceLastPayment > 30;
  const overdueMonths = isOverdue ? Math.floor(daysSinceLastPayment / 30) : 0;
  
  const nextPaymentDate = new Date(lastPayment);
  nextPaymentDate.setDate(lastPayment.getDate() + 30);
  
  const baseAmount = MONTHLY_PAYMENT;
  const penaltyAmount = isOverdue ? baseAmount * PENALTY_RATE * overdueMonths : 0;
  const totalAmount = baseAmount + penaltyAmount;
  
  const daysUntilNextPayment = Math.ceil((nextPaymentDate - now) / (1000 * 60 * 60 * 24));
  
  return {
    nextPaymentDate: nextPaymentDate.toISOString(),
    daysUntilNextPayment,
    isOverdue,
    overdueMonths,
    baseAmount,
    penaltyAmount,
    totalAmount,
    lastPaymentDate: lastPaymentDate
  };
}

function emitFileUpdate(filename, data) {
  const eventName = filename.replace('.json', '') + 'Update';
  io.emit(eventName, { filename, data, timestamp: new Date().toISOString() });
  
  switch(filename) {
    case 'users.json':
      io.to('admin').emit('usersUpdate', data);
      break;
    case 'transactions.json':
      io.to('admin').emit('transactionsUpdate', data);
      data.forEach(transaction => {
        if (transaction.userId) {
          io.to(`user_${transaction.userId}`).emit('transactionUpdate', transaction);
        }
      });
      break;
    case 'withdrawals.json':
      io.to('admin').emit('withdrawalsUpdate', data);
      break;
  }
}

function sendNotificationToUser(userId, notification) {
  io.to(`user_${userId}`).emit('notification', notification);
}

function sendNotificationToAdmin(notification) {
  io.to('admin').emit('adminNotification', notification);
}

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join-user-room', (userId) => {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} joined their room`);
    
    readJsonFile('transactions.json').then(transactions => {
      const userTransactions = transactions.filter(t => t.userId === userId);
      socket.emit('initialTransactions', userTransactions);
    });
  });

  socket.on('join-admin-room', () => {
    socket.join('admin');
    console.log('Admin joined admin room');
    
    Promise.all([
      readJsonFile('users.json'),
      readJsonFile('transactions.json'),
      readJsonFile('withdrawals.json')
    ]).then(([users, transactions, withdrawals]) => {
      socket.emit('initialAdminData', {
        users: users.length,
        pendingPayments: transactions.filter(t => t.status === 'pending' && t.type === 'payment').length,
        pendingWithdrawals: withdrawals.filter(w => w.status === 'pending').length
      });
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const users = await readJsonFile('users.json');
    const user = users.find(u => {
      const userToken = generateToken(u);
      return userToken === token;
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// ============ FIXED PROFILE ROUTES ============
app.get('/api/profile', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const users = await readJsonFile('users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Get referral stats
    const allUsers = await readJsonFile('users.json');
    const userReferrals = allUsers.filter(u => u.referredBy === user.id);
    
    // Calculate referral bonus (5% of each referral's payments)
    const transactions = await readJsonFile('transactions.json');
    let totalReferralBonus = 0;
    
    userReferrals.forEach(referral => {
      const referralPayments = transactions.filter(t => 
        t.userId === referral.id && t.status === 'completed' && t.type === 'payment'
      );
      referralPayments.forEach(payment => {
        totalReferralBonus += payment.amount * (REFERRAL_BONUS_PERCENTAGE / 100);
      });
    });
    
    res.json({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      accountNumber: user.accountNumber,
      accountName: user.accountName,
      bankName: user.bankName,
      referralCode: user.referralCode,
      referralLink: user.referralLink,
      balance: user.balance,
      avatar: user.avatar,
      referredBy: user.referredBy,
      referralStats: {
        totalReferrals: userReferrals.length,
        activeReferrals: userReferrals.filter(u => u.lastPaymentDate).length,
        totalBonus: totalReferralBonus
      }
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/profile', authenticateUser, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, bankName, accountNumber, accountName } = req.body;
    const userId = req.user.id;
    
    const users = await readJsonFile('users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update user data
    users[userIndex].firstName = firstName || users[userIndex].firstName;
    users[userIndex].lastName = lastName || users[userIndex].lastName;
    users[userIndex].email = email || users[userIndex].email;
    users[userIndex].phone = phone || users[userIndex].phone;
    users[userIndex].bankName = bankName || users[userIndex].bankName;
    users[userIndex].accountNumber = accountNumber || users[userIndex].accountNumber;
    users[userIndex].accountName = accountName || users[userIndex].accountName;
    users[userIndex].updatedAt = new Date().toISOString();
    
    await writeJsonFile('users.json', users);
    
    // Emit socket event for real-time update
    io.to(`user_${userId}`).emit('profileUpdated', {
      firstName: users[userIndex].firstName,
      lastName: users[userIndex].lastName,
      email: users[userIndex].email,
      phone: users[userIndex].phone,
      avatar: users[userIndex].avatar
    });
    
    res.json({
      message: 'Profile updated successfully',
      user: users[userIndex]
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/profile/avatar', authenticateUser, async (req, res) => {
  try {
    const { avatar } = req.body;
    const userId = req.user.id;
    
    if (!avatar) {
      return res.status(400).json({ error: 'Avatar image is required' });
    }
    
    const users = await readJsonFile('users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    users[userIndex].avatar = avatar;
    users[userIndex].updatedAt = new Date().toISOString();
    
    await writeJsonFile('users.json', users);
    
    io.to(`user_${userId}`).emit('profileUpdated', {
      avatar: avatar
    });
    
    res.json({
      message: 'Avatar updated successfully',
      avatar: avatar
    });
  } catch (error) {
    console.error('Avatar update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});
// ============ END PROFILE ROUTES ============

app.post('/api/register', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, accountNumber, accountName, bankName, referralCode } = req.body;
    const origin = req.headers.origin || 'http://localhost:3000';
    
    if (!firstName || !lastName || !email || !phone || !accountNumber || !accountName || !bankName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const users = await readJsonFile('users.json');
    
    if (users.some(u => u.email === email)) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    if (users.some(u => u.phone === phone)) {
      return res.status(400).json({ error: 'Phone number already registered' });
    }

    const userReferralCode = generateReferralCode(firstName);
    const referralLink = `${origin}/signup?ref=${userReferralCode}`;

    const newUser = {
      id: `user_${Date.now()}`,
      firstName,
      lastName,
      email,
      phone,
      accountNumber,
      accountName,
      bankName,
      referralCode: userReferralCode,
      referralLink,
      balance: 0,
      isVerified: false,
      isAdmin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      avatar: null,
      loginAttempts: 0,
      paymentHistory: [],
      nextPaymentDate: null,
      lastPaymentDate: null,
      isPaymentOverdue: false,
      overdueAmount: 0,
      referrals: [],
      referredBy: referralCode || null,
      savingsCycle: 1,
      totalSavedCurrentCycle: 0,
      monthsCompletedCurrentCycle: 0
    };

    users.push(newUser);
    await writeJsonFile('users.json', users);

    const token = generateToken(newUser);

    sendNotificationToAdmin({
      id: `notif_${Date.now()}`,
      title: '👤 New User Registration',
      message: `${firstName} ${lastName} has registered on the platform`,
      type: 'user',
      isRead: false,
      createdAt: new Date().toISOString(),
      userId: newUser.id
    });

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: newUser.id,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        email: newUser.email,
        phone: newUser.phone,
        accountNumber: newUser.accountNumber,
        accountName: newUser.accountName,
        bankName: newUser.bankName,
        referralCode: newUser.referralCode,
        referralLink: newUser.referralLink,
        balance: newUser.balance,
        isVerified: newUser.isVerified
      },
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const users = await readJsonFile('users.json');
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const token = generateToken(user);

    const userIndex = users.findIndex(u => u.id === user.id);
    users[userIndex].lastLogin = new Date().toISOString();
    await writeJsonFile('users.json', users);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        accountNumber: user.accountNumber,
        accountName: user.accountName,
        bankName: user.bankName,
        referralCode: user.referralCode,
        referralLink: user.referralLink,
        balance: user.balance,
        isAdmin: user.isAdmin,
        isVerified: user.isVerified
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/dashboard', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [users, transactions, savingsPlans, notifications] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('transactions.json'),
      readJsonFile('savings_plans.json'),
      readJsonFile('notifications.json')
    ]);
    
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userTransactions = transactions.filter(t => t.userId === userId && !t.archived);
    const userNotifications = notifications.filter(n => n.userId === userId && !n.isRead);
    
    const totalSaved = user.totalSavedCurrentCycle || 0;
    const monthsCompleted = user.monthsCompletedCurrentCycle || 0;
    
    let nextPaymentInfo = null;
    if (user.lastPaymentDate) {
      nextPaymentInfo = calculateNextPayment(user, user.lastPaymentDate);
      
      if (nextPaymentInfo.daysUntilNextPayment <= 3 && nextPaymentInfo.daysUntilNextPayment > 0) {
        sendNotificationToUser(userId, {
          id: `notif_${Date.now()}`,
          title: '⏰ Payment Reminder',
          message: `Your next payment of ₦${nextPaymentInfo.totalAmount.toLocaleString()} is due in ${nextPaymentInfo.daysUntilNextPayment} day(s)`,
          type: 'payment_reminder',
          isRead: false,
          createdAt: new Date().toISOString()
        });
      }
      
      if (nextPaymentInfo.daysUntilNextPayment === 0) {
        sendNotificationToUser(userId, {
          id: `notif_${Date.now()}`,
          title: '💰 Payment Due Today!',
          message: `Your payment of ₦${nextPaymentInfo.totalAmount.toLocaleString()} is due today.`,
          type: 'payment_due',
          isRead: false,
          createdAt: new Date().toISOString()
        });
      }
      
      if (nextPaymentInfo.isOverdue) {
        const userIndex = users.findIndex(u => u.id === userId);
        users[userIndex].isPaymentOverdue = true;
        users[userIndex].overdueAmount = nextPaymentInfo.penaltyAmount;
        await writeJsonFile('users.json', users);
        
        sendNotificationToUser(userId, {
          id: `notif_${Date.now()}`,
          title: '⚠️ Payment Overdue!',
          message: `Your payment is ${nextPaymentInfo.overdueMonths} month(s) overdue. Penalty: ₦${nextPaymentInfo.penaltyAmount.toLocaleString()}`,
          type: 'payment_overdue',
          isRead: false,
          createdAt: new Date().toISOString()
        });
      }
    }

    res.json({
      user: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        accountNumber: user.accountNumber,
        accountName: user.accountName,
        bankName: user.bankName,
        referralCode: user.referralCode,
        referralLink: user.referralLink,
        balance: user.balance,
        avatar: user.avatar,
        isVerified: user.isVerified,
        lastPaymentDate: user.lastPaymentDate,
        isPaymentOverdue: user.isPaymentOverdue || false,
        overdueAmount: user.overdueAmount || 0,
        savingsCycle: user.savingsCycle || 1,
        totalSavedCurrentCycle: totalSaved,
        monthsCompletedCurrentCycle: monthsCompleted
      },
      totalSaved,
      monthsCompleted,
      nextPaymentInfo,
      recentTransactions: userTransactions
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5),
      unreadNotifications: userNotifications.length
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/payments', authenticateUser, async (req, res) => {
  try {
    const { receiptImage } = req.body;
    const userId = req.user.id;
    
    if (!receiptImage) {
      return res.status(400).json({ error: 'Receipt image is required' });
    }

    const [users, transactions, config] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('transactions.json'),
      readJsonFile('config.json')
    ]);

    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let paymentAmount = config.monthlyPaymentAmount;
    let penaltyAmount = 0;
    
    if (user.isPaymentOverdue && user.overdueAmount > 0) {
      penaltyAmount = user.overdueAmount;
      paymentAmount += penaltyAmount;
    }

    const filename = await saveBase64Image(receiptImage, userId);

    const newTransaction = {
      id: `txn_${Date.now()}`,
      userId,
      type: 'payment',
      amount: paymentAmount,
      baseAmount: config.monthlyPaymentAmount,
      penaltyAmount: penaltyAmount,
      date: new Date().toISOString(),
      status: 'pending',
      receiptImage: filename,
      description: penaltyAmount > 0 ? 
        `Monthly payment with ₦${penaltyAmount.toLocaleString()} penalty` : 
        'Monthly payment'
    };

    transactions.push(newTransaction);
    await writeJsonFile('transactions.json', transactions);

    const userIndex = users.findIndex(u => u.id === userId);
    users[userIndex].lastPaymentDate = new Date().toISOString();
    users[userIndex].isPaymentOverdue = false;
    users[userIndex].overdueAmount = 0;
    users[userIndex].nextPaymentDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    
    users[userIndex].paymentHistory = users[userIndex].paymentHistory || [];
    users[userIndex].paymentHistory.push({
      date: new Date().toISOString(),
      amount: paymentAmount,
      penalty: penaltyAmount,
      status: 'pending'
    });
    
    await writeJsonFile('users.json', users);

    const notifications = await readJsonFile('notifications.json');
    notifications.push({
      id: `notif_${Date.now()}`,
      userId,
      title: '📤 Payment Submitted',
      message: `Your payment of ₦${paymentAmount.toLocaleString()} has been submitted for review`,
      type: 'payment',
      isRead: false,
      createdAt: new Date().toISOString()
    });
    await writeJsonFile('notifications.json', notifications);

    sendNotificationToUser(userId, {
      id: `notif_${Date.now()}`,
      title: '📤 Payment Submitted',
      message: `₦${paymentAmount.toLocaleString()} payment submitted for review`,
      type: 'payment',
      isRead: false,
      createdAt: new Date().toISOString()
    });

    sendNotificationToAdmin({
      id: `notif_${Date.now()}`,
      title: '💰 New Payment',
      message: `${user.firstName} ${user.lastName} submitted ₦${paymentAmount.toLocaleString()} payment`,
      type: 'payment',
      isRead: false,
      createdAt: new Date().toISOString(),
      userId: userId
    });

    io.to('admin').emit('newPayment', newTransaction);
    io.to(`user_${userId}`).emit('transactionAdded', newTransaction);

    res.status(201).json({
      message: 'Payment submitted for review',
      transaction: newTransaction,
      nextPaymentInfo: calculateNextPayment(user, new Date().toISOString())
    });
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/withdrawals', authenticateUser, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const userId = req.user.id;
    
    const withdrawals = await readJsonFile('withdrawals.json');
    let userWithdrawals = withdrawals.filter(w => w.userId === userId);
    
    if (status) userWithdrawals = userWithdrawals.filter(w => w.status === status);
    
    const sortedWithdrawals = userWithdrawals.sort((a, b) => 
      new Date(b.date) - new Date(a.date)
    );
    
    if (limit) {
      res.json(sortedWithdrawals.slice(0, parseInt(limit)));
    } else {
      res.json(sortedWithdrawals);
    }
  } catch (error) {
    console.error('Withdrawals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// FIXED: WITHDRAWAL CONFIRMATION WITH DASHBOARD RESET
app.post('/api/withdrawals/:id/confirm', authenticateUser, async (req, res) => {
  try {
    const withdrawalId = req.params.id;
    const { confirmed } = req.body;
    const userId = req.user.id;
    
    const withdrawals = await readJsonFile('withdrawals.json');
    const withdrawalIndex = withdrawals.findIndex(w => w.id === withdrawalId && w.userId === userId);
    
    if (withdrawalIndex === -1) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    
    if (confirmed) {
      // Mark withdrawal as confirmed
      withdrawals[withdrawalIndex].confirmed = true;
      withdrawals[withdrawalIndex].confirmedAt = new Date().toISOString();
      withdrawals[withdrawalIndex].status = 'completed';
      withdrawals[withdrawalIndex].userNote = 'Confirmed by user';
      
      // RESET USER'S DASHBOARD TO ZERO
      const users = await readJsonFile('users.json');
      const userIndex = users.findIndex(u => u.id === userId);
      
      if (userIndex !== -1) {
        // Reset all savings data
        users[userIndex].totalSavedCurrentCycle = 0;
        users[userIndex].monthsCompletedCurrentCycle = 0;
        users[userIndex].lastPaymentDate = null;
        users[userIndex].nextPaymentDate = null;
        users[userIndex].isPaymentOverdue = false;
        users[userIndex].overdueAmount = 0;
        users[userIndex].balance = 0;
        
        // Archive all transactions
        const transactions = await readJsonFile('transactions.json');
        transactions.forEach(t => {
          if (t.userId === userId) {
            t.archived = true;
          }
        });
        
        // Increment savings cycle
        users[userIndex].savingsCycle = (users[userIndex].savingsCycle || 1) + 1;
        
        // Save all changes
        await writeJsonFile('users.json', users);
        await writeJsonFile('transactions.json', transactions);
      }
      
      sendNotificationToAdmin({
        id: `notif_${Date.now()}`,
        title: '✅ Withdrawal Confirmed',
        message: `User confirmed receipt of withdrawal and dashboard has been reset`,
        type: 'withdrawal',
        isRead: false,
        createdAt: new Date().toISOString(),
        userId: userId
      });
      
      // Send notification to user about reset
      sendNotificationToUser(userId, {
        id: `notif_${Date.now()}`,
        title: '🔄 Dashboard Reset',
        message: 'Your dashboard has been reset to start a new savings cycle!',
        type: 'reset',
        isRead: false,
        createdAt: new Date().toISOString()
      });
      
    } else {
      withdrawals[withdrawalIndex].status = 'rejected';
      withdrawals[withdrawalIndex].userNote = 'Rejected by user';
      
      sendNotificationToAdmin({
        id: `notif_${Date.now()}`,
        title: '❌ Withdrawal Rejected',
        message: `User rejected withdrawal`,
        type: 'withdrawal',
        isRead: false,
        createdAt: new Date().toISOString(),
        userId: userId
      });
    }
    
    await writeJsonFile('withdrawals.json', withdrawals);
    
    io.to('admin').emit('withdrawalUpdated', withdrawals[withdrawalIndex]);
    io.to(`user_${userId}`).emit('withdrawalUpdated', withdrawals[withdrawalIndex]);
    
    res.json({
      message: `Withdrawal ${confirmed ? 'confirmed and dashboard reset' : 'rejected'}`,
      withdrawal: withdrawals[withdrawalIndex]
    });
  } catch (error) {
    console.error('Withdrawal confirmation error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN ROUTES ============

// GET dashboard stats
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const [users, transactions, withdrawals] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('transactions.json'),
      readJsonFile('withdrawals.json')
    ]);
    
    const totalUsers = users.length;
    
    let overdueUsers = 0;
    let pendingReceipts = 0;
    let eligibleForWithdrawal = 0;
    
    users.forEach(user => {
      if (user.monthsCompletedCurrentCycle >= 6) {
        eligibleForWithdrawal++;
      }
      
      if (user.lastPaymentDate) {
        const nextPayment = calculateNextPayment(user, user.lastPaymentDate);
        if (nextPayment.isOverdue) {
          overdueUsers++;
        }
      }
    });
    
    pendingReceipts = transactions.filter(t => 
      t.type === 'payment' && t.status === 'pending'
    ).length;
    
    res.json({
      stats: {
        totalUsers,
        overdueUsers,
        eligibleForWithdrawal,
        pendingReceipts
      }
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET users with filters
app.get('/api/admin/users', async (req, res) => {
  try {
    const { search, page = 1, limit = 20, filter } = req.query;
    const users = await readJsonFile('users.json');
    
    let filteredUsers = [...users];
    
    if (search) {
      const searchTerm = search.toLowerCase();
      filteredUsers = filteredUsers.filter(user => 
        user.firstName.toLowerCase().includes(searchTerm) ||
        user.lastName.toLowerCase().includes(searchTerm) ||
        user.email.toLowerCase().includes(searchTerm) ||
        user.phone.includes(search) ||
        user.referralCode.toLowerCase().includes(searchTerm)
      );
    }
    
    if (filter === 'eligible') {
      filteredUsers = filteredUsers.filter(user => 
        user.monthsCompletedCurrentCycle >= 6
      );
    } else if (filter === 'overdue') {
      filteredUsers = filteredUsers.filter(user => {
        if (!user.lastPaymentDate) return false;
        const nextPayment = calculateNextPayment(user, user.lastPaymentDate);
        return nextPayment.isOverdue;
      });
    } else if (filter === 'pending_receipts') {
      const transactions = await readJsonFile('transactions.json');
      filteredUsers = filteredUsers.filter(user => {
        const userTransactions = transactions.filter(t => t.userId === user.id);
        return userTransactions.some(t => t.type === 'payment' && t.status === 'pending');
      });
    }
    
    const enrichedUsers = filteredUsers.map(user => {
      let nextPaymentInfo = null;
      let countdown = null;
      
      if (user.lastPaymentDate) {
        nextPaymentInfo = calculateNextPayment(user, user.lastPaymentDate);
        const nextPaymentDate = new Date(nextPaymentInfo.nextPaymentDate);
        const now = new Date();
        const timeDiff = nextPaymentDate - now;
        
        countdown = {
          days: Math.floor(timeDiff / (1000 * 60 * 60 * 24)),
          hours: Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
          minutes: Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60)),
          seconds: Math.floor((timeDiff % (1000 * 60)) / 1000),
          totalSeconds: Math.floor(timeDiff / 1000),
          isOverdue: timeDiff < 0
        };
      }
      
      const isEligible = user.monthsCompletedCurrentCycle >= 6;
      
      return {
        ...user,
        nextPaymentInfo,
        countdown,
        isEligible,
        totalSaved: user.totalSavedCurrentCycle || 0,
        monthsCompleted: user.monthsCompletedCurrentCycle || 0
      };
    });
    
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedUsers = enrichedUsers.slice(startIndex, endIndex);
    
    res.json({
      total: filteredUsers.length,
      page: parseInt(page),
      limit: parseInt(limit),
      users: paginatedUsers
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET user details
app.get('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const users = await readJsonFile('users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    let nextPaymentInfo = null;
    let countdown = null;
    
    if (user.lastPaymentDate) {
      nextPaymentInfo = calculateNextPayment(user, user.lastPaymentDate);
      const nextPaymentDate = new Date(nextPaymentInfo.nextPaymentDate);
      const now = new Date();
      const timeDiff = nextPaymentDate - now;
      
      countdown = {
        days: Math.floor(timeDiff / (1000 * 60 * 60 * 24)),
        hours: Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((timeDiff % (1000 * 60)) / 1000),
        totalSeconds: Math.floor(timeDiff / 1000),
        isOverdue: timeDiff < 0
      };
    }
    
    const stats = {
      totalSaved: user.totalSavedCurrentCycle || 0,
      monthsCompleted: user.monthsCompletedCurrentCycle || 0,
      isEligible: user.monthsCompletedCurrentCycle >= 6
    };
    
    res.json({
      user,
      stats,
      nextPaymentInfo,
      countdown
    });
  } catch (error) {
    console.error('User details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PROCESS WITHDRAWAL (Admin sends receipt to user)
app.post('/api/admin/withdrawals/process', async (req, res) => {
  try {
    const { userId, receiptImage, message } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const [users, withdrawals] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('withdrawals.json')
    ]);
    
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if user is eligible
    if (user.monthsCompletedCurrentCycle < 6) {
      return res.status(400).json({ 
        error: 'User must complete 6 months of savings before withdrawal' 
      });
    }

    let receiptFilename = null;
    if (receiptImage) {
      receiptFilename = await saveBase64Image(receiptImage, userId);
    }

    const withdrawalAmount = user.totalSavedCurrentCycle || 0;

    const newWithdrawal = {
      id: `with_${Date.now()}`,
      userId,
      amount: withdrawalAmount,
      status: 'pending', // User needs to confirm this
      receiptImage: receiptFilename,
      adminMessage: message || 'Withdrawal processed by admin',
      date: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      confirmed: false,
      userDetails: {
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        phone: user.phone,
        accountNumber: user.accountNumber,
        accountName: user.accountName,
        bankName: user.bankName
      }
    };

    withdrawals.push(newWithdrawal);
    await writeJsonFile('withdrawals.json', withdrawals);

    sendNotificationToUser(userId, {
      id: `notif_${Date.now()}`,
      title: '💸 Withdrawal Processed',
      message: `Your withdrawal of ₦${withdrawalAmount.toLocaleString()} has been processed. Please confirm receipt to start new savings cycle.`,
      type: 'withdrawal',
      isRead: false,
      createdAt: new Date().toISOString(),
      withdrawalId: newWithdrawal.id
    });

    sendNotificationToAdmin({
      id: `notif_${Date.now()}`,
      title: '💸 Withdrawal Processed',
      message: `Withdrawal of ₦${withdrawalAmount.toLocaleString()} processed for ${user.firstName} ${user.lastName}`,
      type: 'withdrawal',
      isRead: false,
      createdAt: new Date().toISOString(),
      userId: userId
    });

    io.to('admin').emit('withdrawalProcessed', newWithdrawal);
    io.to(`user_${userId}`).emit('withdrawalCreated', newWithdrawal);

    res.status(201).json({
      message: 'Withdrawal processed successfully',
      withdrawal: newWithdrawal
    });
  } catch (error) {
    console.error('Admin withdrawal error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET ELIGIBLE USERS FOR WITHDRAWAL
app.get('/api/admin/withdrawals/eligible', async (req, res) => {
  try {
    const [users, withdrawals] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('withdrawals.json')
    ]);
    
    const eligibleUsers = users.filter(user => 
      user.monthsCompletedCurrentCycle >= 6
    ).map(user => {
      const userWithdrawals = withdrawals.filter(w => w.userId === user.id);
      const hasPendingWithdrawals = userWithdrawals.some(w => w.status === 'pending');
      
      return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        accountNumber: user.accountNumber,
        accountName: user.accountName,
        bankName: user.bankName,
        monthsCompleted: user.monthsCompletedCurrentCycle || 0,
        totalSaved: user.totalSavedCurrentCycle || 0,
        isEligible: true,
        hasPendingWithdrawals: hasPendingWithdrawals,
        withdrawals: userWithdrawals,
        hasReceipts: userWithdrawals.some(w => w.receiptImage),
        confirmedWithdrawals: userWithdrawals.filter(w => w.confirmed).length,
        lastWithdrawal: userWithdrawals.sort((a, b) => new Date(b.date) - new Date(a.date))[0]
      };
    });
    
    res.json(eligibleUsers);
  } catch (error) {
    console.error('Eligible users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET all withdrawals
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const withdrawals = await readJsonFile('withdrawals.json');
    const users = await readJsonFile('users.json');
    
    const enrichedWithdrawals = withdrawals.map(withdrawal => {
      const user = users.find(u => u.id === withdrawal.userId);
      return {
        ...withdrawal,
        userName: user ? `${user.firstName} ${user.lastName}` : 'Unknown User',
        userEmail: user ? user.email : 'N/A',
        userPhone: user ? user.phone : 'N/A'
      };
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
    
    res.json(enrichedWithdrawals);
  } catch (error) {
    console.error('Admin withdrawals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/Reject payments
app.put('/api/admin/payments/:paymentId', async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const { action } = req.body;
    
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const [transactions, users] = await Promise.all([
      readJsonFile('transactions.json'),
      readJsonFile('users.json')
    ]);
    
    const paymentIndex = transactions.findIndex(t => t.id === paymentId);
    if (paymentIndex === -1) return res.status(404).json({ error: 'Payment not found' });

    const userId = transactions[paymentIndex].userId;
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

    if (action === 'approve') {
      transactions[paymentIndex].status = 'completed';
      transactions[paymentIndex].processedAt = new Date().toISOString();
      
      // Update user's savings progress
      users[userIndex].totalSavedCurrentCycle = (users[userIndex].totalSavedCurrentCycle || 0) + 
        transactions[paymentIndex].amount;
      users[userIndex].monthsCompletedCurrentCycle = (users[userIndex].monthsCompletedCurrentCycle || 0) + 1;
      
      sendNotificationToUser(userId, {
        id: `notif_${Date.now()}`,
        title: '✅ Payment Approved',
        message: `Your payment of ₦${transactions[paymentIndex].amount.toLocaleString()} has been approved`,
        type: 'payment',
        isRead: false,
        createdAt: new Date().toISOString()
      });

      io.to(`user_${userId}`).emit('paymentApproved', transactions[paymentIndex]);
      
    } else {
      transactions[paymentIndex].status = 'rejected';
      transactions[paymentIndex].processedAt = new Date().toISOString();

      sendNotificationToUser(userId, {
        id: `notif_${Date.now()}`,
        title: '❌ Payment Rejected',
        message: 'Your payment receipt was rejected',
        type: 'payment',
        isRead: false,
        createdAt: new Date().toISOString()
      });

      io.to(`user_${userId}`).emit('paymentRejected', transactions[paymentIndex]);
    }

    await Promise.all([
      writeJsonFile('transactions.json', transactions),
      writeJsonFile('users.json', users)
    ]);

    res.json({
      message: `Payment ${action === 'approve' ? 'approved' : 'rejected'}`,
      transaction: transactions[paymentIndex]
    });
  } catch (error) {
    console.error('Payment action error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send reminder to user
app.post('/api/admin/users/:id/remind', async (req, res) => {
  try {
    const userId = req.params.id;
    const { message } = req.body;
    
    const users = await readJsonFile('users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    sendNotificationToUser(userId, {
      id: `notif_${Date.now()}`,
      title: '🔔 Admin Reminder',
      message: message || 'This is a reminder from admin',
      type: 'reminder',
      isRead: false,
      createdAt: new Date().toISOString()
    });
    
    res.json({
      message: 'Reminder sent successfully'
    });
  } catch (error) {
    console.error('Reminder error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify user account
app.put('/api/admin/users/:id/verify', async (req, res) => {
  try {
    const userId = req.params.id;
    
    const users = await readJsonFile('users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
    
    users[userIndex].isVerified = true;
    users[userIndex].updatedAt = new Date().toISOString();
    
    await writeJsonFile('users.json', users);
    
    sendNotificationToUser(userId, {
      id: `notif_${Date.now()}`,
      title: '✅ Account Verified',
      message: 'Your account has been verified by admin',
      type: 'verification',
      isRead: false,
      createdAt: new Date().toISOString()
    });
    
    res.json({
      message: 'User verified successfully'
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PAGE ROUTES ============
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'index.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'dashboard.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'profile.html'));
});

app.get('/save', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'save.html'));
});

app.get('/transactions', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'transactions.html'));
});

app.get('/withdraw', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'withdraw.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-users.html'));
});

app.get('/admin/payments', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-payments.html'));
});

app.get('/admin/withdrawals', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-withdrawal.html'));
});

app.get('/admin/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-users.html'));
});

// ============ ERROR HANDLING ============
app.use((req, res) => {
  console.log(`404: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ============ INITIALIZE SERVER ============
initDirectories().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 User interface: http://localhost:${PORT}`);
    console.log(`👑 Admin interface: http://localhost:${PORT}/admin`);
    console.log(`🔄 Real-time features: Enabled`);
    console.log(`🔄 Dashboard reset on withdrawal confirmation: Enabled`);
    console.log(`✅ Profile API: Enabled`);
  });
}).catch(err => {
  console.error('❌ Failed to initialize directories:', err);
  process.exit(1);
});