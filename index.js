const express=require('express')
const http = require('http')
const { Server } = require('socket.io')
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const app = express()
const server = http.createServer(app)


const io = new Server(server, {
    cors: {
      origin: ["*"], // Added localhost
      methods: ["GET", "POST"]
    }
  });

  const userSocketMap = new Map();


  app.use(express.json())

  app.set('views', __dirname + '/public/views');
  app.set('view engine', 'ejs');
  
  


  app.get('/', (req, res) => {
    res.render('index');

});


//Api Calls
  app.post('/api/deviceid', async (req, res) => {
    try 
    {
      const { deviceid } = req.body;

      if (!deviceid) 
      {
        return res.status(400).json({ error: 'Device ID is required' });
      }
  
      const existingDevice = await prisma.deviceid.findUnique({ where: { deviceid } });

      if (existingDevice) 
      {
        return res.status(200).json({ status: 'false', message: 'Device ID already exists', device: existingDevice });
      }
  
      const device = await prisma.deviceid.create({ data: { deviceid, available: false } });

      res.status(201).json({ status: 'true', device });

    } 
    catch (error) 
    {
      console.error('Error creating orr retrieving device ID:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });


  app.post('/api/appclose', async (req, res) => {
    try 
    {
      const { deviceid } = req.body;

      if (!deviceid) 
      {
        return res.status(400).json({ error: 'Device ID is required' });
      }

      const device = await prisma.deviceid.findUnique({ where: { deviceid } });

      if (!device)
      {
        return res.status(404).json({ error: 'Device not found' });
      }
  
      const updatedDevice = await prisma.deviceid.update({
        where: { deviceid },
        data: { available: false },
      });
  
      res.status(200).json({ status: 'true', device: updatedDevice });

    } 
    catch (error) 
    {
      console.error('Error creating or retrieving device ID:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });


  app.post('/api/deviceid/report', async (req, res) => {
    try 
    {
      const { deviceid } = req.body;

      if (!deviceid) 
      {
        return res.status(400).json({ error: 'Device ID is required' });
      }
  
      const device = await prisma.deviceid.findUnique({ where: { deviceid } });

      if (!device)
      {
        return res.status(404).json({ error: 'Device not found' });
      }
  

      const updatedDevice = await prisma.deviceid.update({
        where: { deviceid },
        data: { reports: { increment: 1 } }
      });
  
      if (updatedDevice.reports >= 5) 
      {
        const blockedUntil = new Date();
        blockedUntil.setDate(blockedUntil.getDate() + 10);

        await prisma.deviceid.update({
          where: { deviceid },
          data: {
            blocked: true,
            blockedUntil
          }
        });

        console.log(`Device ${deviceid} has been blocked for 10 dayss`);
      }
  
      res.status(200).json({ message: 'Device reportedd successfully' });
    }
    catch (error)
    {
      console.error('Error reportting devicee:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });


//SocketEvents

  io.on('connection', socket => {
    console.log(`A user connected: ${socket.id}`);

  
    socket.on('registerorjoin', async (deviceId) => {
      try 
      {
        const device = await prisma.deviceid.findUnique({ where: { deviceid: deviceId } });
        const senderId=device.id

        if (device && device.blocked) 
        {
          const currentDate = new Date();

          if (device.blockedUntil && currentDate < device.blockedUntil) 
          {
            console.log(`Device ${deviceId} is blocked until ${device.blockedUntil}. Connection denied.`);
            socket.emit('connectionDenied', { message: 'Your device is blocked' });
            return;
          }
          else
          {
            await prisma.deviceid.update({
              where: { deviceid: deviceId },
              data: { blocked: false, blockedUntil: null }
            });
            console.log(`Device ${deviceId} has been unblockedd.`);
          }
        }

        const connectedUsers = Array.from(userSocketMap.keys());

        if(connectedUsers.length>0)
        {
            const randomIndex = Math.floor(Math.random() * connectedUsers.length);
            const receiverId = connectedUsers[randomIndex];
            const room = [senderId, receiverId].sort().join('-');
            socket.join(room)
            io.to(socket.id).emit('joined', room);
            const receiverSocketId = userSocketMap.get(receiverId);
            const isDelete=userSocketMap.delete(receiverId)
            if(isDelete)
            {
                await prisma.deviceid.updateMany({where: {id: {in: [parseInt(senderId), parseInt(receiverId)],},},data:{available: false,},});
                io.to(receiverSocketId).emit('roomReady', room);
            }
        }
        else
        {
            userSocketMap.set(senderId, socket.id);
            console.log("searching for a user to pair")
            io.to(socket.id).emit('searching');
        }
      } catch (error) {
        console.error('Error during join:', error);
      }
    });


    socket.on('joinRoom', (room) => {
        try
        {
        socket.join(room);
        io.to(socket.id).emit('joined', room);
        let userId;
        myMap.forEach((value, key) => {
            if (value === socket.id) 
            {
            userId = key;
            }
        });
        console.log(`User ${userId} joined room ${room}`);
        }
        catch(err)
        {
          console.log(err)
        }
      });



      socket.on('message', async ({message,deviceId,room}) => {
        try 
        {
            const messageDetails={message,deviceId}
            io.to(room).emit('message',messageDetails)
            console.log(`sending message to ${room} by ${deviceId}:${message}`)
        } 
        catch (error) {
          console.error('Error sending message:', error);
        }
      });


      socket.on('skip', async (room) => {
        // Step 1: Emit a clearChat message to the room
        io.to(room).emit('clearChat');
    
        // Optional: Wait a short time to ensure clients process the clearChat message
        await new Promise(resolve => setTimeout(resolve, 100));
    
        // Step 2: Fetch all sockets in the room
        const socketsInRoom = await io.in(room).fetchSockets();
    
        // Collect the IDs of the sockets in the room
        const socketIds = socketsInRoom.map(socketInRoom => socketInRoom.id);
    
        // Make each socket leave the room
        socketsInRoom.forEach(socketInRoom => {
          socketInRoom.leave(room);
        });
    
        // Step 3: Emit reJoin event to each of the sockets that left the room
        socketIds.forEach(socketId => {
          io.to(socketId).emit('reJoin',room);
        });
      });



      socket.on('reJoin', async (deviceId,room) => {
        try 
        {
          const device = await prisma.deviceid.findUnique({ where: { deviceid: deviceId } });
          const senderId=device.id
  
          if (device && device.blocked) 
          {
            const currentDate = new Date();
  
            if (device.blockedUntil && currentDate < device.blockedUntil) 
            {
              console.log(`Device ${deviceId} is blocked until ${device.blockedUntil}. Connection denied.`);
              socket.emit('connectionDenied', { message: 'Your device is blocked' });
              return;
            }
            else
            {
              await prisma.deviceid.update({
                where: { deviceid: deviceId },
                data: { blocked: false, blockedUntil: null }
              });
              console.log(`Device ${deviceId} has been unblockedd.`);
            }
          }
  
          var connectedUsers = Array.from(userSocketMap.keys());
          const previousUsers = room.split('-').map(part => parseInt(part, 10));
          connectedUsers = connectedUsers.filter(item => !previousUsers.includes(item));
  
          if(connectedUsers.length>0)
          {
              const randomIndex = Math.floor(Math.random() * connectedUsers.length);
              const receiverId = connectedUsers[randomIndex];
              const room = [senderId, receiverId].sort().join('-');
              socket.join(room)
              io.to(socket.id).emit('joined', room);
              const receiverSocketId = userSocketMap.get(receiverId);
              const isDelete=userSocketMap.delete(receiverId)
              if(isDelete)
              {
                  await prisma.deviceid.updateMany({where: {id: {in: [parseInt(senderId), parseInt(receiverId)],},},data:{available: false,},});
                  io.to(receiverSocketId).emit('roomReady', room);
              }
          }
          else
          {
              userSocketMap.set(senderId, socket.id);
              console.log("searching for a user to pair")
              io.to(socket.id).emit('searching');
          }
        } catch (error) {
          console.error('Error during join:', error);
        }
      });

      socket.on('leaveRoom', async (room) => {
        try {
            // Make the socket leave the specified room
            socket.leave(room);
    
            console.log(`Socket ${socket.id} left room ${room}`);
        } catch (error) {
            console.error('Error during leaveRoom:', error);
        }
    });



      socket.on('disconnectRoom', async (room) => {
        try {
          console.log(room)
            io.to(room).emit('userDisconnected', { message: 'A user has disconnected.' });
            socket.leave(room);
            console.log(`Socket ${socket.id} left room ${room}`);
        } catch (error) {
            console.error('Error handling disconnectRoom:', error);
        }
    });
    
    
    
    

    
      


  });




  server.listen(3000, () => {
    console.log('Server is running on port 3000');
});