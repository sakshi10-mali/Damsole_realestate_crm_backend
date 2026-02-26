const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

let io;

/**
 * Initialize Socket.IO server
 */
function initializeSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Authentication middleware for Socket.IO
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.firstName} ${socket.user.lastName} (${socket.user.role})`);
    
    // Join user-specific room
    socket.join(`user:${socket.user._id}`);
    
    // Join role-based room
    socket.join(`role:${socket.user.role}`);
    
    // Join agency room if applicable
    if (socket.user.agency) {
      socket.join(`agency:${socket.user.agency}`);
    }

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.user.firstName} ${socket.user.lastName}`);
    });

    // Handle custom events
    socket.on('join-room', (room) => {
      socket.join(room);
    });

    socket.on('leave-room', (room) => {
      socket.leave(room);
    });
  });

  return io;
}

/**
 * Emit notification to specific user
 */
function notifyUser(userId, notification) {
  if (io) {
    io.to(`user:${userId}`).emit('notification', notification);
  }
}

/**
 * Emit notification to all users in an agency
 */
function notifyAgency(agencyId, notification) {
  if (io) {
    io.to(`agency:${agencyId}`).emit('notification', notification);
  }
}

/**
 * Emit notification to all users with a specific role
 */
function notifyRole(role, notification) {
  if (io) {
    io.to(`role:${role}`).emit('notification', notification);
  }
}

/**
 * Emit notification to all connected clients
 */
function notifyAll(notification) {
  if (io) {
    io.emit('notification', notification);
  }
}

/**
 * Emit activity update
 */
function emitActivity(activity) {
  if (io) {
    // Emit to relevant rooms based on activity
    if (activity.agency) {
      io.to(`agency:${activity.agency}`).emit('activity', activity);
    }
    if (activity.relatedUsers && activity.relatedUsers.length > 0) {
      activity.relatedUsers.forEach(userId => {
        io.to(`user:${userId}`).emit('activity', activity);
      });
    }
    io.to(`role:${activity.performedBy.role}`).emit('activity', activity);
  }
}

module.exports = {
  initializeSocket,
  notifyUser,
  notifyAgency,
  notifyRole,
  notifyAll,
  emitActivity,
  getIO: () => io
};

