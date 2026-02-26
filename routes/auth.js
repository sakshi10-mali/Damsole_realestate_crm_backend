const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const RolePermission = require('../models/RolePermission');
const AgencyPermission = require('../models/AgencyPermission');
const UserPermission = require('../models/UserPermission');
const { auth } = require('../middleware/auth');
const emailService = require('../services/emailService');

async function getEffectivePermissions(userId, userRole, userAgency) {
  if (userRole === 'super_admin') {
    return {
      leads: { view: true, create: true, edit: true, delete: true },
      properties: { view: true, create: true, edit: true, delete: true },
      inquiries: { view: true, create: true, edit: true, delete: true },
      contact_messages: { view: true, create: true, edit: true, delete: true },
      users: { view: true, create: true, edit: true, delete: true },
      agencies: { view: true, create: true, edit: true, delete: true }
    };
  }
  let permDoc = await UserPermission.findOne({ user: userId });
  if (permDoc && permDoc.permissions) {
    return JSON.parse(JSON.stringify(permDoc.permissions));
  }
  if (userAgency && ['agency_admin', 'agent', 'staff'].includes(userRole)) {
    permDoc = await AgencyPermission.findOne({ agency: userAgency });
    if (permDoc && permDoc.permissions) {
      return JSON.parse(JSON.stringify(permDoc.permissions));
    }
  }
  permDoc = await RolePermission.findOne({ role: userRole });
  if (permDoc && permDoc.permissions) {
    return JSON.parse(JSON.stringify(permDoc.permissions));
  }
  return {};
}

const router = express.Router();

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'fallback_secret', {
    expiresIn: process.env.JWT_EXPIRE || '30m'
  });
};

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(['agency_admin', 'agent', 'staff', 'user']).withMessage('Valid role is required. Super admin cannot be registered publicly.'),
  body('isActive').optional().isBoolean().withMessage('isActive must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { firstName, lastName, email, password, role, agency, phone, address } = req.body;

    // Prevent super_admin registration through public registration
    // Super admin can only be created by existing super admin or through system scripts
    if (role === 'super_admin') {
      return res.status(403).json({ message: 'Super admin accounts cannot be created through public registration. Please contact system administrator.' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    // Validate agency if provided
    let agencyId = null;
    if (agency) {
      // Handle both string and ObjectId formats
      const agencyString = typeof agency === 'string' ? agency.trim() : agency.toString();
      if (agencyString && agencyString !== '') {
        // Check if agency exists (if provided)
        const Agency = require('../models/Agency');
        const agencyExists = await Agency.findById(agencyString);
        if (!agencyExists) {
          return res.status(400).json({ message: 'Invalid agency ID' });
        }
        agencyId = agencyString;
      }
    }

    // For agent and agency_admin roles, agency can be assigned later by super admin
    // So we allow registration without agency, but set status to pending
    const userData = {
      firstName,
      lastName,
      email,
      password,
      role,
      phone,
      address
    };

    // Only set agency if provided and valid
    if (agencyId) {
      userData.agency = agencyId;
    }

    // For agents and agency_admins without agency, they need approval
    // If agency is provided, the agent should be active immediately
    // If no agency, they need approval (only in production)
    if ((role === 'agent' || role === 'agency_admin') && !agencyId) {
      // For development/testing: set to true
      // For production: set to false to require admin approval
      userData.isActive = process.env.NODE_ENV === 'production' ? false : true;
    } else {
      // If agency is provided, agent should be active immediately
      // This covers agents created by agency admins
      userData.isActive = true;
    }

    // Allow explicit isActive override from request body (for admin-created users)
    if (req.body.isActive !== undefined) {
      userData.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }

    // Create new user
    const user = new User(userData);

    await user.save();

    // Generate token
    const token = generateToken(user._id);

    // Send welcome email (Non-blocking)
    setImmediate(async () => {
      try {
        await emailService.sendWelcomeEmail(user);
      } catch (emailError) {
        console.error('Failed to send welcome email:', emailError);
      }
    });

    const responseMessage = (role === 'agent' || role === 'agency_admin') && !agencyId
      ? 'Registration successful! Your account is pending approval from an administrator.'
      : 'User registered successfully';

    res.status(201).json({
      message: responseMessage,
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        agency: user.agency,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
      keyValue: error.keyValue
    });

    // Handle specific error types
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        message: 'Validation error',
        errors: validationErrors
      });
    }

    // Handle duplicate key error (email already exists)
    if (error.code === 11000 || error.name === 'MongoServerError') {
      const field = Object.keys(error.keyValue || {})[0];
      return res.status(400).json({
        message: `${field ? field.charAt(0).toUpperCase() + field.slice(1) : 'Field'} already exists`
      });
    }

    // Handle CastError (invalid ObjectId format)
    if (error.name === 'CastError') {
      return res.status(400).json({
        message: `Invalid ${error.path || 'field'} format`
      });
    }

    // Return more detailed error for debugging in development
    res.status(500).json({
      message: 'Server error during registration',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    if (process.env.NODE_ENV === 'development') {
      console.log('Login attempt for email:', (email || '').trim().toLowerCase());
    }

    if (!email || !password) {
      return res.status(400).json({
        message: 'Email and password are required',
        error: 'MISSING_CREDENTIALS'
      });
    }

    // Normalize email (lowercase) and trim password
    const normalizedEmail = email.toLowerCase().trim();
    const trimmedPassword = password.trim();

    // Find user by email - IMPORTANT: select password field explicitly
    // Password is excluded by default in toJSON, so we need to select it
    const user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (!user) {
      if (process.env.NODE_ENV === 'development') {
        console.log('Login 401: no user for email:', normalizedEmail);
      }
      return res.status(401).json({
        message: 'Invalid email or password',
        error: 'USER_NOT_FOUND'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      if (process.env.NODE_ENV === 'development') {
        console.log('Login 401: user inactive:', normalizedEmail);
      }
      return res.status(401).json({
        message: 'Your account is pending approval. Please contact an administrator.',
        error: 'ACCOUNT_INACTIVE'
      });
    }

    // Check password - make sure password field exists
    if (!user.password) {
      console.error('Login: user has no password set:', user._id);
      return res.status(500).json({ message: 'Account error. Please contact support.' });
    }

    const isMatch = await user.comparePassword(trimmedPassword);

    if (!isMatch) {
      if (process.env.NODE_ENV === 'development') {
        console.log('Login 401: wrong password for:', normalizedEmail);
      }
      return res.status(401).json({
        message: 'Invalid email or password',
        error: 'INVALID_PASSWORD'
      });
    }

    // Update last login (Non-blocking)
    User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } }).catch(err => console.error('Last login update error:', err));

    // Generate token
    const token = generateToken(user._id);

    // Send login notification email (Non-blocking)
    setImmediate(async () => {
      try {
        await emailService.sendLoginNotificationEmail(user);
      } catch (emailError) {
        console.error('Failed to send login notification email:', emailError);
      }
    });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        agency: user.agency,
        lastLogin: user.lastLogin,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      message: 'Server error during login',
      error: error.message
    });
  }
});

// @route   POST /api/auth/refresh-token
// @desc    Issue new access token using current (possibly expired) JWT
// @access  Private (sends Bearer token in header)
router.post('/refresh-token', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', {
        ignoreExpiration: true
      });
    } catch (err) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const user = await User.findById(decoded.userId).populate('agency', 'name logo');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (!user.isActive) {
      return res.status(401).json({ message: 'Account is inactive' });
    }

    const newToken = generateToken(user._id);
    res.json({
      token: newToken,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        agency: user.agency ? (typeof user.agency === 'object' ? user.agency._id : user.agency) : null,
        agencyName: user.agency && typeof user.agency === 'object' ? user.agency.name : null,
        lastLogin: user.lastLogin,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user and effective permissions (for hiding denied modules on frontend)
// @access  Private
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('agency', 'name logo');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const agencyId = user.agency ? (typeof user.agency === 'object' ? user.agency._id : user.agency) : null;
    const permissions = await getEffectivePermissions(req.user.id, user.role, agencyId);

    res.json({
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        agency: user.agency ? (typeof user.agency === 'object' ? user.agency._id : user.agency) : null,
        agencyName: user.agency && typeof user.agency === 'object' ? user.agency.name : null,
        phone: user.phone,
        address: user.address,
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        profileImage: user.profileImage,
        agentInfo: user.agentInfo,
        staffInfo: user.staffInfo
      },
      permissions
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Send password reset email
// @access  Public
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Generate reset token
    const resetToken = jwt.sign(
      { userId: user._id, type: 'password_reset' },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '1h' }
    );

    // Send password reset email
    try {
      await emailService.sendPasswordResetEmail(user, resetToken);
      res.json({
        message: 'Password reset email sent successfully'
      });
    } catch (emailError) {
      console.error('Failed to send password reset email:', emailError);
      res.status(500).json({ message: 'Failed to send password reset email' });
    }
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password with token
// @access  Public
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, password } = req.body;

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    if (decoded.type !== 'password_reset') {
      return res.status(400).json({ message: 'Invalid token' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update password
    user.password = password;
    await user.save();

    // Send confirmation email in background
    setImmediate(async () => {
      try {
        await emailService.sendPasswordChangeConfirmation(user);
      } catch (emailError) {
        console.error('Error sending password confirmation email:', emailError);
      }
    });

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
