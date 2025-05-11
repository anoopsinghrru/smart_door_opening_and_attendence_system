const express = require('express');
const mongoose = require('mongoose');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const nodemailer = require('nodemailer');
const exceljs = require('exceljs');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.static('views')); // Serve static files from views directory as well
app.use(express.urlencoded({ extended: true }));

// MongoDB connection (using MongoDB Atlas)
mongoose.connect('mongodb+srv://anoopsingh201004:pRjCsjfnrws6qFMt@cluster0.fneai71.mongodb.net/attendance?retryWrites=true&w=majority', {
  serverSelectionTimeoutMS: 30000 // Increase timeout to 30 seconds
})
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB Atlas connection error:', err));

// Schemas
const UserSchema = new mongoose.Schema({
  name: String,
  email: String,
  tagID: String,
  password: String,
  enrollmentNumber: String,
  batch: String,
  semester: String
});
const User = mongoose.model('User', UserSchema);

const AttendanceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  entryTime: Date,
  exitTime: Date,
  stayTime: Number // in minutes
});
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// Serial port setup (replace with your Arduino's port, e.g., 'COM3' on Windows or '/dev/ttyUSB0' on Linux)
const port = new SerialPort({ path: 'COM3', baudRate: 9600 });
port.on('error', (err) => {
  console.error('SerialPort error:', err.message);
});
const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

// Send user data to Arduino
async function sendUsersToArduino() {
  try {
    // Wait for MongoDB connection to be ready
    if (mongoose.connection.readyState !== 1) {
      console.log('MongoDB not connected yet, skipping sendUsersToArduino');
      return;
    }
    const users = await User.find();
    let userString = "USERS:";
    users.forEach(user => {
      userString += `${user.tagID},${user.password};`;
    });
    port.write(userString + '\n');
    console.log('Sent users to Arduino:', userString);
  } catch (err) {
    console.error('Error fetching users for Arduino:', err.message);
  }
}

// Send users on startup
port.on('open', () => {
  console.log('Serial port opened');
  // Delay sending users until MongoDB is connected
  mongoose.connection.once('open', () => {
    sendUsersToArduino();
  });
});

// Handle serial data
parser.on('data', async (data) => {
  try {
    const message = data.trim();
    if (message.startsWith('AUTH:')) {
      const tagID = message.split(':')[1];
      const user = await User.findOne({ tagID });
      if (user) {
        const latestAttendance = await Attendance.findOne({ user: user._id, exitTime: null });
        if (latestAttendance) {
          // Exit
          latestAttendance.exitTime = new Date();
          const stayTime = (latestAttendance.exitTime - latestAttendance.entryTime) / 60000;
          latestAttendance.stayTime = stayTime;
          await latestAttendance.save();

          // Send email
          sendEmail(
            `${user.name} (Enrollment: ${user.enrollmentNumber}, Batch: ${user.batch}, Semester: ${user.semester}) exited at ${latestAttendance.exitTime}, stayed for ${stayTime.toFixed(2)} minutes`,
            user.email
          );

          // Emit updated attendance to all connected clients
          const updatedAttendance = await Attendance.findById(latestAttendance._id).populate('user');

          // Create a unique key for this exit event
          const exitKey = `${updatedAttendance.user._id}-${updatedAttendance.entryTime.getTime()}-exit`;

          // Only emit if we haven't recently emitted this exit
          if (!recentlyEmittedExits.has(exitKey)) {
            io.emit('attendance_update', { type: 'update', attendance: updatedAttendance });
            recentlyEmittedExits.set(exitKey, new Date().getTime());
          }
        } else {
          // Entry
          const newAttendance = new Attendance({
            user: user._id,
            entryTime: new Date(),
            exitTime: null,
            stayTime: 0
          });
          await newAttendance.save();

          // Send email
          sendEmail(
            `${user.name} (Enrollment: ${user.enrollmentNumber}, Batch: ${user.batch}, Semester: ${user.semester}) entered at ${newAttendance.entryTime}`,
            user.email
          );

          // Emit new attendance to all connected clients
          const populatedAttendance = await Attendance.findById(newAttendance._id).populate('user');

          // Create a unique key for this entry event
          const entryKey = `${populatedAttendance.user._id}-${populatedAttendance.entryTime.getTime()}`;

          // Only emit if we haven't recently emitted this entry
          if (!recentlyEmittedEntries.has(entryKey)) {
            io.emit('attendance_update', { type: 'new', attendance: populatedAttendance });
            recentlyEmittedEntries.set(entryKey, new Date().getTime());
          }
        }
      } else {
        console.log(`Unknown tagID: ${tagID}`);
      }
    }
  } catch (err) {
    console.error('Error processing serial data:', err.message);
  }
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'abc240031@gmail.com',
    pass: 'oyls eiua ifmx bvyp'
  }
});

function sendEmail(message, recipientEmail) {
  const mailOptions = {
    from: 'abc240031@gmail.com',
    to: recipientEmail,
    subject: 'Attendance Update',
    text: message
  };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) console.log('Email error:', error.message);
    else console.log('Email sent: ' + info.response);
  });
}

// Routes
app.get('/', async (req, res) => {
  try {
    // Render the index page - this is the home/landing page
    res.render('index');
  } catch (err) {
    console.error('Error rendering index page:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Route for attendance page
app.get('/attendence', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';

    // Build query based on search and date filters
    let query = {};

    // If search parameter exists
    if (search) {
      // We need to first find users that match the search criteria
      const users = await User.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { enrollmentNumber: { $regex: search, $options: 'i' } },
          { tagID: { $regex: search, $options: 'i' } }
        ]
      });

      // Get the user IDs to use in the attendance query
      const userIds = users.map(user => user._id);

      // Add user filter to the query
      if (userIds.length > 0) {
        query.user = { $in: userIds };
      } else {
        // If no users match the search, return empty results
        query._id = null;
      }
    }

    // Add date range filter if provided
    if (startDate || endDate) {
      query.entryTime = {};

      if (startDate) {
        const startDateTime = new Date(startDate);
        startDateTime.setHours(0, 0, 0, 0);
        query.entryTime.$gte = startDateTime;
      }

      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        query.entryTime.$lte = endDateTime;
      }
    }

    const totalAttendances = await Attendance.countDocuments(query);
    const totalPages = Math.ceil(totalAttendances / limit);

    // Get attendance records sorted by newest first
    const attendances = await Attendance.find(query)
      .populate('user')
      .sort({ entryTime: -1 }) // Sort by entry time, newest first
      .skip(skip)
      .limit(limit);

    res.render('attendence', {
      attendances,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      search,
      startDate,
      endDate
    });
  } catch (err) {
    console.error('Error fetching attendances for attendance page:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Route for registration page
app.get('/registration', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';

    // Build search query if search parameter exists
    let query = {};
    if (search) {
      query = {
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { enrollmentNumber: { $regex: search, $options: 'i' } },
          { tagID: { $regex: search, $options: 'i' } }
        ]
      };
    }

    const totalUsers = await User.countDocuments(query);
    const totalPages = Math.ceil(totalUsers / limit);

    const users = await User.find(query)
      .sort({ name: 1 }) // Sort by name alphabetically
      .skip(skip)
      .limit(limit);

    res.render('registration', {
      users,
      editUser: null,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      search // Pass search parameter to the view
    });
  } catch (err) {
    console.error('Error fetching users for registration page:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/download', async (req, res) => {
  try {
    const search = req.query.search || '';
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';

    // Build query based on search and date filters
    let query = {};

    // If search parameter exists
    if (search) {
      // We need to first find users that match the search criteria
      const users = await User.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { enrollmentNumber: { $regex: search, $options: 'i' } },
          { tagID: { $regex: search, $options: 'i' } }
        ]
      });

      // Get the user IDs to use in the attendance query
      const userIds = users.map(user => user._id);

      // Add user filter to the query
      if (userIds.length > 0) {
        query.user = { $in: userIds };
      } else {
        // If no users match the search, return empty results
        query._id = null;
      }
    }

    // Add date range filter if provided
    if (startDate || endDate) {
      query.entryTime = {};

      if (startDate) {
        const startDateTime = new Date(startDate);
        startDateTime.setHours(0, 0, 0, 0);
        query.entryTime.$gte = startDateTime;
      }

      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        query.entryTime.$lte = endDateTime;
      }
    }

    // Get attendance records sorted by newest first
    const attendances = await Attendance.find(query)
      .populate('user')
      .sort({ entryTime: -1 }); // Sort by entry time, newest first
    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('Attendance');
    worksheet.columns = [
      { header: 'User Name', key: 'name', width: 20 },
      { header: 'Enrollment Number', key: 'enrollmentNumber', width: 20 },
      { header: 'Batch', key: 'batch', width: 15 },
      { header: 'Semester', key: 'semester', width: 15 },
      { header: 'Entry Time', key: 'entryTime', width: 25 },
      { header: 'Exit Time', key: 'exitTime', width: 25 },
      { header: 'Stay Time (min)', key: 'stayTime', width: 15 }
    ];

    // Add filter information to the Excel file
    if (search || startDate || endDate) {
      const filterRow = worksheet.addRow(['Filters:']);
      filterRow.font = { bold: true };

      if (search) {
        worksheet.addRow(['Search', search]);
      }

      if (startDate) {
        worksheet.addRow(['Start Date', startDate]);
      }

      if (endDate) {
        worksheet.addRow(['End Date', endDate]);
      }

      // Add empty row for spacing
      worksheet.addRow([]);
    }

    attendances.forEach(att => {
      worksheet.addRow({
        name: att.user.name,
        enrollmentNumber: att.user.enrollmentNumber,
        batch: att.user.batch,
        semester: att.user.semester,
        entryTime: att.entryTime,
        exitTime: att.exitTime,
        stayTime: att.exitTime ? att.stayTime : 'Still inside'
      });
    });

    // Set filename with filter information
    let filename = 'attendance';
    if (search) filename += '_search-' + search.replace(/[^a-z0-9]/gi, '-');
    if (startDate) filename += '_from-' + startDate;
    if (endDate) filename += '_to-' + endDate;
    filename += '.xlsx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating Excel file:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const totalUsers = await User.countDocuments();
    const totalPages = Math.ceil(totalUsers / limit);

    const users = await User.find()
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit);

    // Use the registration view instead of users view
    res.render('registration', {
      users,
      editUser: null,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    });
  } catch (err) {
    console.error('Error fetching users:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/users/add', async (req, res) => {
  try {
    const { name, email, tagID, password, enrollmentNumber, batch, semester } = req.body;
    await User.create({ name, email, tagID, password, enrollmentNumber, batch, semester });
    await sendUsersToArduino();

    // Always redirect to registration page
    res.redirect('/registration');
  } catch (err) {
    console.error('Error adding user:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/users/edit/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    const users = await User.find();

    // Always use the registration view
    res.render('registration', {
      users,
      editUser: user,
      currentPage: 1,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false
    });
  } catch (err) {
    console.error('Error fetching user for edit:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/users/edit/:id', async (req, res) => {
  try {
    const { name, email, tagID, password, enrollmentNumber, batch, semester } = req.body;
    await User.findByIdAndUpdate(req.params.id, { name, email, tagID, password, enrollmentNumber, batch, semester });
    await sendUsersToArduino();

    // Always redirect to registration page
    res.redirect('/registration');
  } catch (err) {
    console.error('Error updating user:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/users/delete/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    await sendUsersToArduino();

    // Always redirect to registration page
    res.redirect('/registration');
  } catch (err) {
    console.error('Error deleting user:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  // Send initial data when a client connects
  socket.on('get_latest_attendance', async () => {
    try {
      // Get the latest 10 attendance records, strictly sorted by newest first
      const latestAttendances = await Attendance.find()
        .populate('user')
        .sort({ entryTime: -1 }) // -1 means descending order (newest first)
        .limit(10);

      socket.emit('initial_attendance', latestAttendances);
    } catch (err) {
      console.error('Error fetching initial attendance data:', err.message);
    }
  });
});

// API endpoint to get latest attendance data
app.get('/api/attendance', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';

    // Build query based on search and date filters
    let query = {};

    // If search parameter exists
    if (search) {
      // We need to first find users that match the search criteria
      const users = await User.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { enrollmentNumber: { $regex: search, $options: 'i' } },
          { tagID: { $regex: search, $options: 'i' } }
        ]
      });

      // Get the user IDs to use in the attendance query
      const userIds = users.map(user => user._id);

      // Add user filter to the query
      if (userIds.length > 0) {
        query.user = { $in: userIds };
      } else {
        // If no users match the search, return empty results
        query._id = null;
      }
    }

    // Add date range filter if provided
    if (startDate || endDate) {
      query.entryTime = {};

      if (startDate) {
        const startDateTime = new Date(startDate);
        startDateTime.setHours(0, 0, 0, 0);
        query.entryTime.$gte = startDateTime;
      }

      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        query.entryTime.$lte = endDateTime;
      }
    }

    const totalAttendances = await Attendance.countDocuments(query);
    const totalPages = Math.ceil(totalAttendances / limit);

    // Get attendance records sorted by newest first
    const attendances = await Attendance.find(query)
      .populate('user')
      .sort({ entryTime: -1 }) // Sort by entry time, newest first
      .skip(skip)
      .limit(limit);

    res.json({
      attendances,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    });
  } catch (err) {
    console.error('Error fetching attendance data:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Keep track of recently emitted entries to avoid duplicates
const recentlyEmittedEntries = new Map();
const recentlyEmittedExits = new Map();

// Function to periodically check for new attendance records
async function checkForNewAttendance() {
  try {
    // Get the current timestamp
    const now = new Date();

    // Check for attendance records created or updated in the last 30 seconds
    const recentTime = new Date(now.getTime() - 30000); // 30 seconds ago

    // Find recently created entries
    const newEntries = await Attendance.find({
      entryTime: { $gte: recentTime },
      exitTime: null
    }).populate('user');

    // Find recently updated exits
    const recentExits = await Attendance.find({
      exitTime: { $gte: recentTime }
    }).populate('user');

    // Emit events for new entries (avoiding duplicates)
    newEntries.forEach(entry => {
      const entryKey = `${entry.user._id}-${entry.entryTime.getTime()}`;

      // Check if we've already emitted this entry recently
      if (!recentlyEmittedEntries.has(entryKey)) {
        io.emit('attendance_update', { type: 'new', attendance: entry });

        // Add to recently emitted map with a timestamp
        recentlyEmittedEntries.set(entryKey, now.getTime());
      }
    });

    // Emit events for recent exits (avoiding duplicates)
    recentExits.forEach(exit => {
      const exitKey = `${exit.user._id}-${exit.entryTime.getTime()}-exit`;

      // Check if we've already emitted this exit recently
      if (!recentlyEmittedExits.has(exitKey)) {
        io.emit('attendance_update', { type: 'update', attendance: exit });

        // Add to recently emitted map with a timestamp
        recentlyEmittedExits.set(exitKey, now.getTime());
      }
    });

    // Clean up old entries from the maps (older than 1 minute)
    const cleanupTime = now.getTime() - 60000; // 1 minute ago

    recentlyEmittedEntries.forEach((timestamp, key) => {
      if (timestamp < cleanupTime) {
        recentlyEmittedEntries.delete(key);
      }
    });

    recentlyEmittedExits.forEach((timestamp, key) => {
      if (timestamp < cleanupTime) {
        recentlyEmittedExits.delete(key);
      }
    });
  } catch (err) {
    console.error('Error checking for new attendance:', err.message);
  }
}

// Set up periodic checking (every 10 seconds)
setInterval(checkForNewAttendance, 10000);

// Start the server
server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});