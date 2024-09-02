const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const findKeyByValue = require('./utilityfunctions/utils.js');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for development purposes; adjust for production
    methods: ["GET", "POST"]
  }
});

const userSocketMap = new Map();

app.use(express.json());
app.set('views', __dirname + '/public/views');
app.set('view engine', 'ejs');

app.get('/', (req, res) => {
  res.render('index');
});



// API Endpoints
app.post('/api/deviceid', async (req, res) => {
  try {
    const { deviceid } = req.body;
    if (!deviceid) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const existingDevice = await prisma.deviceid.findUnique({ where: { deviceid } });
    if (existingDevice) {
      return res.status(200).json({ status: 'false', message: 'Device ID already exists', device: existingDevice });
    }

    const device = await prisma.deviceid.create({ data: { deviceid, available: false } });
    res.status(201).json({ status: 'true', device });

  } catch (error) {
    console.error('Error creating or retrieving device ID:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/appclose', async (req, res) => {
  try {
    const { deviceid } = req.body;
    if (!deviceid) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const device = await prisma.deviceid.findUnique({ where: { deviceid } });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updatedDevice = await prisma.deviceid.update({
      where: { deviceid },
      data: { available: false },
    });

    res.status(200).json({ status: 'true', device: updatedDevice });

  } catch (error) {
    console.error('Error closing app for device ID:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/deviceid/report', async (req, res) => {
  try {
    const { deviceid } = req.body;
    if (!deviceid) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const device = await prisma.deviceid.findUnique({ where: { deviceid } });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updatedDevice = await prisma.deviceid.update({
      where: { deviceid },
      data: { reports: { increment: 1 } }
    });

    if (updatedDevice.reports >= 5) {
      const blockedUntil = new Date();
      blockedUntil.setDate(blockedUntil.getDate() + 10);

      await prisma.deviceid.update({
        where: { deviceid },
        data: {
          blocked: true,
          blockedUntil
        }
      });

      console.log(`Device ${deviceid} has been blocked for 10 days`);
    }

    res.status(200).json({ message: 'Device reported successfully' });
  } catch (error) {
    console.error('Error reporting device:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket Events
io.on('connection', (socket) => {
  console.log(`A user connected: ${socket.id}`);

  socket.on('registerorjoin', async (deviceId) => {
    try {
      const device = await prisma.deviceid.findUnique({ where: { deviceid: deviceId } });
      const senderId = device.id;

      if (device && device.blocked) {
        const currentDate = new Date();

        if (device.blockedUntil && currentDate < device.blockedUntil) {
          console.log(`Device ${deviceId} is blockedd until ${device.blockedUntil}. Connection denied.`);
          socket.emit('connectionDenied', { message: 'Your device is blocked' });
          return;
        } else {
          await prisma.deviceid.update({
            where: { deviceid: deviceId },
            data: { blocked: false, blockedUntil: null }
          });
          console.log(`Device ${deviceId} has been unblocked.`);
        }
      }

      const connectedUsers = Array.from(userSocketMap.keys());
      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];
        const room = [senderId, receiverId].sort().join('-');
        socket.join(room);
        io.to(socket.id).emit('joined', room);

        const receiverSocketId = userSocketMap.get(receiverId);
        const isDeleted = userSocketMap.delete(receiverId);

        if (isDeleted) {
          await prisma.deviceid.updateMany({
            where: { id: { in: [parseInt(senderId), parseInt(receiverId)] } },
            data: { available: false },
          });
          io.to(receiverSocketId).emit('roomReady', room);
        }
      } else {
        userSocketMap.set(senderId, socket.id);
        console.log("Searching for a user to pair");
        io.to(socket.id).emit('searching');
      }
    } catch (error) {
      console.error('Error during join:', error);
    }
  });

  socket.on('joinRoom', (room) => {
    try {
      socket.join(room);
      console.log(`Socket ${socket.id} joined room ${room}`);
      io.to(socket.id).emit('joined', room);
    } catch (err) {
      console.error('Error joining room:', err);
    }
  });

  socket.on('message', async ({ message, deviceId, room }) => {
    try {
      console.log(`Received message for room ${room}:`, { message, deviceId });
      io.to(room).emit('message', { message, deviceId });
      console.log(`Message sentt to room ${room}: ${message}`);
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });

  socket.on('skip', async (room) => {
    try {
      // Emit a clearChat message to the room
      io.to(room).emit('clearChat');

      // Optional: Wait a short time to ensure clients process the clearChat message
      await new Promise(resolve => setTimeout(resolve, 100));

      // Fetch all sockets in the room
      const socketsInRoom = await io.in(room).fetchSockets();
      const socketIds = socketsInRoom.map(socketInRoom => socketInRoom.id);

      // Make each socket leave the room
      socketsInRoom.forEach(socketInRoom => socketInRoom.leave(room));

      // Emit reJoin event to each of the sockets that left the room
      socketIds.forEach(socketId => io.to(socketId).emit('reJoin', room));
    } catch (error) {
      console.error('Error handling skip:', error);
    }
  });

  socket.on('reJoin', async (deviceId, room) => {
    try {
      const device = await prisma.deviceid.findUnique({ where: { deviceid: deviceId } });
      const senderId = device.id;

      if (device && device.blocked) {
        const currentDate = new Date();

        if (device.blockedUntil && currentDate < device.blockedUntil) {
          console.log(`Device ${deviceId} is blocked until ${device.blockedUntil}. Connection denied.`);
          socket.emit('connectionDenied', { message: 'Your device is blocked' });
          return;
        } else {
          await prisma.deviceid.update({
            where: { deviceid: deviceId },
            data: { blocked: false, blockedUntil: null }
          });
          console.log(`Device ${deviceId} has been unblocked.`);
        }
      }

      let connectedUsers = Array.from(userSocketMap.keys());
      const previousUsers = room.split('-').map(part => parseInt(part, 10));
      connectedUsers = connectedUsers.filter(item => !previousUsers.includes(item));

      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];
        const newRoom = [senderId, receiverId].sort().join('-');
        socket.join(newRoom);
        io.to(socket.id).emit('joined', newRoom);

        const receiverSocketId = userSocketMap.get(receiverId);
        const isDeleted = userSocketMap.delete(receiverId);
        console.log(isDeleted)

        if (isDeleted) {
          await prisma.deviceid.updateMany({
            where: { id: { in: [parseInt(senderId), parseInt(receiverId)] } },
            data: { available: false },
          });
          io.to(receiverSocketId).emit('roomReady', newRoom);
        }
      } else {
        userSocketMap.set(senderId, socket.id);
        console.log("Searching for a user to pair");
        io.to(socket.id).emit('searching');
      }
    } catch (error) {
      console.error('Error during reJoin:', error);
    }
  });

  socket.on('stopSearch', () => {
    try {
      const key = findKeyByValue(userSocketMap, socket.id);
      console.log(key)
      if (key) {
        console.log(`Stopping search for user: ${key}`);
        userSocketMap.delete(key);
        socket.emit('stoppedSearch');
      } else {
        console.log('No matching key found for the current socket.');
        // Optionally, you can notify the client about this case.
      }
    } catch (err) {
      console.error('Error during stopSearch:', err);
    }
  });
  

  socket.on('disconnectRoom', async (room) => {
    try {
      const key=findKeyByValue(userSocketMap, socket.id)
      if(key)
      {
        console.log(key)
        userSocketMap.delete(key)
      }
      if(room)
      {
      const socketsInRoom = await io.in(room).fetchSockets();
      const socketIds = socketsInRoom.map(socketInRoom => socketInRoom.id);
      console.log(socketIds)
      const oppositeSocketId = socketIds.find(id => id !== socket.id);
      console.log(oppositeSocketId)

      io.to(oppositeSocketId).emit('clearChat');
      io.to(oppositeSocketId).emit('reJoin',room);
      
      io.to(oppositeSocketId).emit('userDisconnected', {
        message: `Socket ${socket.id} has disconnected from the room.`,
      });

      }
      socket.leave(room)
      socket.disconnect()
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
