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
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let userSocketMap = new Map();

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

  // Helper function to ensure user leaves any previous room
  const leaveAllRooms = (socket) => {
    const rooms = Array.from(socket.rooms);
    rooms.forEach(room => {
      if (room !== socket.id) {  // Leave any room that is not the socket's own ID
        socket.leave(room);
      }
    });
  };

  socket.on('registerorjoin', async (deviceId) => {
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

      // Ensure the user is not in any existing room
      leaveAllRooms(socket);

      const connectedUsers = Array.from(userSocketMap.keys());
      console.log(`Number of users connected in joining: ${connectedUsers.length}`);

      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];

        if (receiverId !== senderId) {
          const room = [senderId, receiverId].sort().join('-');

          // Check if the room has less than 2 participants
          const socketsInRoom = await io.in(room).fetchSockets();
          if (socketsInRoom.length < 2) {
            // Join the room
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
            io.to(socket.id).emit('roomFull', { message: 'Room already has 2 participants' });
          }
        }
      } else {
        userSocketMap.set(senderId, socket.id);
        io.to(socket.id).emit('searching');
      }
    } catch (error) {
      console.error('Error during join:', error);
    }
  });

  socket.on('message', async ({ message, deviceId, room }) => {
    try {
      io.to(room).emit('message', { message, deviceId });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });

  socket.on('skip', async (room) => {
    try {
      io.to(room).emit('clearChat');
      await new Promise(resolve => setTimeout(resolve, 100));
      const socketsInRoom = await io.in(room).fetchSockets();
      const socketIds = socketsInRoom.map(socketInRoom => socketInRoom.id);

      // Remove users from the room before rejoining
      socketsInRoom.forEach(socketInRoom => {
        socketInRoom.leave(room);
      });

      socketIds.forEach(socketId => {
        io.to(socketId).emit('reJoin', room);
      });
    } catch (error) {
      console.error('Error handling skip:', error);
    }
  });

  socket.on('reJoin', async (deviceId, room) => {
    try {
      const device = await prisma.deviceid.findUnique({ where: { deviceid: deviceId } });
      const senderId = device.id;

      // Leave any previous room before rejoining
      leaveAllRooms(socket);

      let connectedUsers = Array.from(userSocketMap.keys());
      const previousUsers = room.split('-').map(part => parseInt(part, 10));
      connectedUsers = connectedUsers.filter(item => !previousUsers.includes(item));

      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];
        if (senderId !== receiverId) {
          const newRoom = [senderId, receiverId].sort().join('-');

          // Check room size before joining
          const socketsInRoom = await io.in(newRoom).fetchSockets();
          if (socketsInRoom.length < 2) {
            socket.join(newRoom);
            io.to(socket.id).emit('joined', newRoom);

            const receiverSocketId = userSocketMap.get(receiverId);
            userSocketMap.delete(receiverId);
            await prisma.deviceid.updateMany({
              where: { id: { in: [parseInt(senderId), parseInt(receiverId)] } },
              data: { available: false },
            });
            io.to(receiverSocketId).emit('roomReady', newRoom);
          } else {
            io.to(socket.id).emit('roomFull', { message: 'Room already has 2 participants' });
          }
        }
      } else {
        userSocketMap.set(senderId, socket.id);
        io.to(socket.id).emit('searching');
      }
    } catch (error) {
      console.error('Error during rejoin:', error);
    }
  });

  socket.on('disconnect', async () => {
    try {
      const disconnectedDeviceId = findKeyByValue(userSocketMap, socket.id);
      if (disconnectedDeviceId) {
        const removed = userSocketMap.delete(disconnectedDeviceId);
        if (removed) {
          await prisma.deviceid.update({ where: { id: parseInt(disconnectedDeviceId) }, data: { available: false } });
          console.log(`User ${disconnectedDeviceId} disconnected`);
        }
      }
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
