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

var userSocketMap = {};

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

      const connectedUsers = Object.keys(userSocketMap);
      console.log(`Number of users connected in joining: ${connectedUsers.length}`);

      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];

        if (receiverId !== senderId) {
          const room = [senderId, receiverId].sort().join('-');

          // Check if socket is in any room
          if (socket.rooms.size === 1) {
            // Socket is not in any room, so join the room
            socket.join(room);
            io.to(socket.id).emit('joined', room);

            const receiverSocketId = userSocketMap[receiverId]; // Accessing value using bracket notation
            if(receiverSocketId)
            {
              const isDeleted = delete userSocketMap[receiverId]; // Deleting the property using the delete operator
              if (isDeleted) {
                await prisma.deviceid.updateMany({
                  where: { id: { in: [parseInt(senderId), parseInt(receiverId)] } },
                  data: { available: false },
                });
                io.to(receiverSocketId).emit('roomReady', room);
              }
            }
          } else {
            console.log(`Socket ${socket.id} is already in a room`);
            io.to(socket.id).emit('alreadyInRoom');
          }
        }
      } else {
        // Only add to map if not already in a room
        if (socket.rooms.size === 1) {
          userSocketMap[senderId] = socket.id;  // For Object
          io.to(socket.id).emit('searching');
        }
      }
    } catch (error) {
      console.error('Error during join:', error);
    }
  });

  socket.on('joinRoom', (room) => {
    try {
      // Check if socket is in any room
      if (socket.rooms.size === 1) {
        // Socket is not in any room, so join the room
        socket.join(room);
        io.to(socket.id).emit('joined', room);
      } else {
        console.log(`Socket ${socket.id} is already in a room`);
        io.to(socket.id).emit('alreadyInRoom');
      }
    } catch (err) {
      console.error('Error joining room:', err);
    }
  });

  socket.on('message', async ({ message, deviceId, room }) => {
    try {
      console.log(`Received message for room ${room}:`, { message, deviceId });
      io.to(room).emit('message', { message, deviceId });
      console.log(`MessagGe sent to room ${room}: ${message}`);
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
      socketsInRoom.forEach(socketInRoom => {
        socketInRoom.leave(room);
        console.log(`Socket with ID ${socketInRoom.id} has left the room: ${room}`);
    });

      // Emit reJoin event to each of the sockets that left the room
      socketIds.forEach(socketId => {
        io.to(socketId).emit('reJoin', room);
        console.log(`Socket with ID ${socketId} has been skipped and trying to rejoin with another room`);
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

      let connectedUsers = Object.keys(userSocketMap);
      const previousUsers = room.split('-').map(part => parseInt(part, 10));
      connectedUsers = connectedUsers.filter(item => !previousUsers.includes(item));

      if (connectedUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * connectedUsers.length);
        const receiverId = connectedUsers[randomIndex];
        if (senderId !== receiverId) {
          const newRoom = [senderId, receiverId].sort().join('-');

          // Check if socket is in any room
          if (socket.rooms.size === 1) {
            // Socket is not in any room, so join the new room
            socket.join(newRoom);
            io.to(socket.id).emit('joined', newRoom);

            const receiverSocketId = userSocketMap.get(receiverId);
            if(receiverSocketId)
            {
              const isDeleted = delete userSocketMap[receiverId]; // Deleting the property using the delete operator
              if (isDeleted) {
                await prisma.deviceid.updateMany({
                  where: { id: { in: [parseInt(senderId), parseInt(receiverId)] } },
                  data: { available: false },
                });
                io.to(receiverSocketId).emit('roomReady', room);
              }

            }
          } else {
            console.log(`Socket ${socket.id} is already in a room`);
            io.to(socket.id).emit('alreadyInRoom');
          }
        }
      } else {
        // Only add to map if not already in a room
        if (socket.rooms.size === 1) {
          userSocketMap[senderId] = socket.id;
          io.to(socket.id).emit('searching');
        }
      }
    } catch (error) {
      console.error('Error during reJoin:', error);
    }
  });

  socket.on('stopSearch', () => {
    try {
      const key = findKeyByValue(userSocketMap, socket.id);
      if (key) {
        var usersWaiting = Object.keys(userSocketMap);
        console.log(`${key} to stop searchc for the ${socket.id}, usersWaiting : ${usersWaiting}`)
        console.log(`Stopping search for user: ${key}`);
        delete userSocketMap[key];
        usersWaiting = Object.keys(userSocketMap);
        console.log(`Stopped search for the ${socket.id}, usersWaiting : ${usersWaiting}`)
        socket.emit('stoppedSearch');
      } else {
        console.log('No matching key found for the current socket...');
        // Optionally, you can notify the client about this case.
      }
    } catch (err) {
      console.error('Errorr during stopSearch:', err);
    }
  });
  

  socket.on('disconnectRoom', async (room) => {
    try {
      console.log(room)
      socket.leave(room);
      console.log(`Socket ${socket.id} has left the room ${room}`);
      const key=findKeyByValue(userSocketMap, socket.id)
      if(key)
      {
        console.log(key)
        delete userSocketMap[key]
        console.log(`Deleted disconnected socket from the user map`);
      }
      if(room)
      {
      const socketsInRoom = await io.in(room).fetchSockets();
      const socketIds = socketsInRoom.map(socketInRoom => socketInRoom.id);
      console.log(socketIds)
      const oppositeSocketId = socketIds.find(id => id !== socket.id);
      if(oppositeSocketId)
      {
      console.log(oppositeSocketId)
      const oppositeSocket = io.sockets.sockets.get(oppositeSocketId);
      oppositeSocket.leave(room);
      console.log(`Socket ${oppositeSocketId} has left the room ${room}`);
      io.to(oppositeSocketId).emit('clearChat');
      io.to(oppositeSocketId).emit('reJoin',room);
      io.to(oppositeSocketId).emit('userDisconnected', {
        message: `Socket ${socket.id} has disconnected from the room.`,
      });
      }

      }
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

// const express = require('express');
// const http = require('http');
// const socketIo = require('socket.io');
// const { PrismaClient } = require('@prisma/client');
// const prisma = new PrismaClient();
// const bodyParser = require('body-parser');

// const app = express();
// const server = http.createServer(app);
// const io = socketIo(server);

// const pairs = {};
// const users = {};
// app.use(bodyParser.json());
// app.set('view engine', 'ejs');

// app.get('/', (req, res) => {
//   res.render('chat');
// });

// app.post('/api/deviceid', async (req, res) => {
//   try {
//     const { deviceid } = req.body;
//     if (!deviceid) {
//       return res.status(400).json({ error: 'Device ID is required' });
//     }

//     const existingDevice = await prisma.deviceid.findUnique({ where: { deviceid } });
//     if (existingDevice) {
//       return res.status(200).json({ status: 'false', message: 'Device ID already exists', device: existingDevice });
//     }

//     const device = await prisma.deviceid.create({ data: { deviceid, available: false } });
//     res.status(201).json({ status: 'true', device });
//   } catch (error) {
//     console.error('Error creating or retrieving device ID:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });
// app.post('/api/appclose', async (req, res) => {
//   try {
//     console.log("deviceid",deviceid)
//     const { deviceid } = req.body;
//     if (!deviceid) {
//       return res.status(400).json({ error: 'Device ID is required' });
//     }
//     // Find the device first
//     const device = await prisma.deviceid.findUnique({ where: { deviceid } });
//     if (!device) {
//       return res.status(404).json({ error: 'Device not found' });
//     }

//     // Update the device
//     const updatedDevice = await prisma.deviceid.update({
//       where: { deviceid },
//       data: { available: false },
//     });

//     res.status(200).json({ status: 'true', device: updatedDevice });
//   } catch (error) {
//     console.error('Error creating or retrieving device ID:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });


// app.post('/api/deviceid/report', async (req, res) => {
//   try {
//     const { deviceid } = req.body;
//     if (!deviceid) {
//       return res.status(400).json({ error: 'Device ID is required' });
//     }

//     const device = await prisma.deviceid.findUnique({ where: { deviceid } });
//     if (!device) {
//       return res.status(404).json({ error: 'Device not found' });
//     }

//     const updatedDevice = await prisma.deviceid.update({
//       where: { deviceid },
//       data: { reports: { increment: 1 } }
//     });

//     if (updatedDevice.reports >= 5) {
//       const blockedUntil = new Date();
//       blockedUntil.setDate(blockedUntil.getDate() + 10);
//       await prisma.deviceid.update({
//         where: { deviceid },
//         data: {
//           blocked: true,
//           blockedUntil
//         }
//       });
//       console.log(`Device ${deviceid} has been blocked for 10 days`);
//     }

//     res.status(200).json({ message: 'Device reported successfully' });
//   } catch (error) {
//     console.error('Error reporting device:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });

// io.on('connection', socket => {
//   console.log('A user connected: ' + socket.id);

//   socket.on('join', async (deviceId) => {
//     try {
//       const device = await prisma.deviceid.findUnique({ where: { deviceid: deviceId } });
//       if (device && device.blocked) {
//         const currentDate = new Date();
//         if (device.blockedUntil && currentDate < device.blockedUntil) {
//           console.log(`Device ${deviceId} is blocked until ${device.blockedUntil}. Cannot join.`);
//           return;
//         } else {
//           await prisma.deviceid.update({
//             where: { deviceid: deviceId },
//             data: { blocked: false, blockedUntil: null }
//           });
//           console.log(`Device ${deviceId} has been unblocked.`);
//         }
//       }
      
//       users[socket.id] = deviceId;
//       const availableUsers = Object.keys(users).filter(id => !pairs[id] && id !== socket.id);
      
//       const randomIndex = Math.floor(Math.random() * availableUsers.length);
//       if (availableUsers.length > 0) {
//         const partnerId = availableUsers[randomIndex];
//         pairs[socket.id] = partnerId;
//         pairs[partnerId] = socket.id;

//         await Promise.all([
//           prisma.deviceid.update({ where: { deviceid: deviceId }, data: { available: false } }),
//           prisma.deviceid.update({ where: { deviceid: users[partnerId] }, data: { available: false } })
//         ]);

//         io.to(socket.id).emit('paired', users[partnerId]);
//         io.to(partnerId).emit('paired', deviceId);
//       }
//     } catch (error) {
//       console.error('Error during join:', error);
//     }
//   });

//   socket.on('message', message => {
//     try {
//       const partnerId = pairs[socket.id];
//       if (partnerId) {
//         io.to(partnerId).emit('message', message);
//       }
//     } catch (error) {
//       console.error('Error during message:', error);
//     }
//   });

//   socket.on('customDisconnect', async () => {
//     try {
//       await disconnectAndNotifyPartner(socket.id, false);
//       delete users[socket.id];
//       socket.disconnect();
//     } catch (error) {
//       console.error('Error during customDisconnect:', error);
//     }
//   });

//   socket.on('skip', async () => {
//     try {
//       await clearChatAndNotifyPartner(socket.id, true);
//     } catch (error) {
//       console.error('Error during skip:', error);
//     }
//   });

//   async function clearChatAndNotifyPartner(userId, isSkip) {
//     try {
//       const partnerId = pairs[userId];
//       if (partnerId) {
//         io.to(partnerId).emit('partnerSkipped');
//         io.to(userId).emit('clearChat');
//         io.to(partnerId).emit('clearChat');

//         await Promise.all([
//           prisma.deviceid.update({ where: { deviceid: users[userId] }, data: { available: true } }),
//           prisma.deviceid.update({ where: { deviceid: users[partnerId] }, data: { available: true } })
//         ]);

//         delete pairs[partnerId];
//         delete pairs[userId];

//         if (isSkip) {
//           const previousPartner = partnerId; 
//           console.log("previousPartner", previousPartner);
//           const availableUsers = Object.keys(users).filter(id => !pairs[id] && id !== socket.id &&  id !== userId && id !== previousPartner);
//           console.log("availableUsers", availableUsers);
//           if (availableUsers.length > 0) {
//             const randomIndex = Math.floor(Math.random() * availableUsers.length);
//             const newPartnerId = availableUsers[randomIndex];
//             pairs[userId] = newPartnerId;
//             pairs[newPartnerId] = userId;
//             io.to(userId).emit('paired', users[newPartnerId]);
//             io.to(newPartnerId).emit('paired', users[userId]);
//           }
//         }
//       }
//     } catch (error) {
//       console.error('Error during clearChatAndNotifyPartner:', error);
//     }
//   }

//   async function disconnectAndNotifyPartner(userId, isSkip) {
//     try {
//       const partnerId = pairs[userId];
//       if (partnerId) {
//         io.to(partnerId).emit('partnerDisconnected');
//         io.to(userId).emit('clearChat');
//         io.to(partnerId).emit('clearChat');

//         await Promise.all([
//           // prisma.deviceid.update({ where: { deviceid: users[userId] }, data: { available: true } }),
//           prisma.deviceid.update({ where: { deviceid: users[partnerId] }, data: { available: true } })
//         ]);

//         delete pairs[partnerId];
//         delete pairs[userId];

//         if (isSkip) {
//           const previousPartner = partnerId; 
//           console.log("previousPartner", previousPartner);
//           const availableUsers = Object.keys(users).filter(id => !pairs[id] && id !== userId && id !== previousPartner);
//           console.log("availableUsers", availableUsers);
//           if (availableUsers.length > 0) {
//             const randomIndex = Math.floor(Math.random() * availableUsers.length);
//             const newPartnerId = availableUsers[randomIndex];
//             pairs[userId] = newPartnerId;
//             pairs[newPartnerId] = userId;
//             io.to(userId).emit('paired', users[newPartnerId]);
//             io.to(newPartnerId).emit('paired', users[userId]);
//           }
//         }
//       }
//     } catch (error) {
//       console.error('Error during disconnectAndNotifyPartner:', error);
//     }
//   }
// });

// const port = process.env.PORT || 3000;
// server.listen(port, () => {
//   console.log(`Server running on port ${port}`);
// });
