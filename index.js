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

let userSocketMap = new Map();

app.use(express.json());
app.set('views', __dirname + '/public/views');
app.set('view engine', 'ejs');

app.get('/', (req, res) => {
  res.render('index');
});

// API Endpoints
app.post('/api/deviceid', async (req, res) => {
  const { deviceid } = req.body;
  if (!deviceid) {
    return res.status(400).json({ error: 'Device ID is required' });
  }

  try {
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
  const { deviceid } = req.body;
  if (!deviceid) {
    return res.status(400).json({ error: 'Device ID is required' });
  }

  try {
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
  const { deviceid } = req.body;
  if (!deviceid) {
    return res.status(400).json({ error: 'Device ID is required' });
  }

  try {
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

      const connectedUsers = Array.from(userSocketMap.keys());
      console.log(`Number of users connected in joining: ${connectedUsers.length}`);

      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];

        if (receiverId !== senderId) {
          const room = [senderId, receiverId].sort().join('-');

          if (socket.rooms.size === 1) {
            socket.join(room);
            io.to(socket.id).emit('joined', room);

            const receiverSocketId = userSocketMap.get(receiverId);
            if (receiverSocketId) {
              userSocketMap.delete(receiverId);
              await prisma.deviceid.updateMany({
                where: { id: { in: [senderId, receiverId] } },
                data: { available: false },
              });
              io.to(receiverSocketId).emit('roomReady', room);
            }
          } else {
            io.to(socket.id).emit('alreadyInRoom');
          }
        }
      } else {
        if (socket.rooms.size === 1) {
          userSocketMap.set(senderId, socket.id);
          io.to(socket.id).emit('searching');
        }
      }
    } catch (error) {
      console.error('Error during join:', error);
    }
  });

  socket.on('joinRoom', (room) => {
    try {
      if (socket.rooms.size === 1) {
        socket.join(room);
        io.to(socket.id).emit('joined', room);
      } else {
        io.to(socket.id).emit('alreadyInRoom');
      }
    } catch (err) {
      console.error('Error joining room:', err);
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

      if (device && device.blocked) {
        const currentDate = new Date();

        if (device.blockedUntil && currentDate < device.blockedUntil) {
          socket.emit('connectionDenied', { message: 'Your device is blocked' });
          return;
        } else {
          await prisma.deviceid.update({
            where: { deviceid: deviceId },
            data: { blocked: false, blockedUntil: null }
          });
        }
      }

      let connectedUsers = Array.from(userSocketMap.keys());
      const previousUsers = room.split('-').map(part => parseInt(part, 10));
      connectedUsers = connectedUsers.filter(item => !previousUsers.includes(item));

      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];

        if (senderId !== receiverId) {
          const newRoom = [senderId, receiverId].sort().join('-');

          if (socket.rooms.size === 1) {
            socket.join(newRoom);
            io.to(socket.id).emit('joined', newRoom);

            const receiverSocketId = userSocketMap.get(receiverId);
            if (receiverSocketId) {
              userSocketMap.delete(receiverId);
              await prisma.deviceid.updateMany({
                where: { id: { in: [senderId, receiverId] } },
                data: { available: false },
              });
              io.to(receiverSocketId).emit('roomReady', newRoom);
            }
          } else {
            io.to(socket.id).emit('alreadyInRoom');
          }
        }
      } else {
        if (socket.rooms.size === 1) {
          userSocketMap.set(senderId, socket.id);
          io.to(socket.id).emit('searching');
        }
      }
    } catch (error) {
      console.error('Error during reJoin:', error);
    }
  });

  socket.on('stopSearch', async (deviceId) => {
    try {
      const device = await prisma.deviceid.findUnique({ where: { deviceid: deviceId } });
      const senderId = device.id;

      if (device) {
        userSocketMap.delete(senderId);
        await prisma.deviceid.update({
          where: { deviceid: deviceId },
          data: { available: false },
        });
      }
    } catch (error) {
      console.error('Error stopping search:', error);
    }
  });

  socket.on('disconnectRoom', async (room) => {
    try {
      const socketsInRoom = await io.in(room).fetchSockets();
      const remainingSockets = socketsInRoom.length;

      if (remainingSockets <= 1) {
        const remainingSocketId = remainingSockets ? socketsInRoom[0].id : null;
        if (remainingSocketId) {
          io.to(remainingSocketId).emit('pairedWithDevice', null);
          await prisma.deviceid.updateMany({
            where: { id: { in: [socket.id] } },
            data: { available: true },
          });
        }
      }
    } catch (error) {
      console.error('Error handling disconnect room:', error);
    }
  });

  socket.on('error', (error) => {
    console.error('Socket.IO Error:', error);
  });

});

server.listen(3000, () => {
  console.log('Server is listening on port 3000');
});
