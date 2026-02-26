const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RolePermission = require('../models/RolePermission');
const AgencyPermission = require('../models/AgencyPermission');
const UserPermission = require('../models/UserPermission');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ message: 'No token, authorization denied' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(401).json({ message: 'Token is not valid' });
    }

    if (!user.isActive) {
      return res.status(401).json({ message: 'Account is deactivated' });
    }

    req.user = {
      id: user._id.toString(),
      role: user.role,
      email: user.email,
      agency: user.agency ? user.agency.toString() : null
    };

    console.log('Auth middleware - User ID:', req.user.id, 'Role:', req.user.role, 'Agency:', req.user.agency || 'None');

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ message: 'Token is not valid' });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    console.log('Authorization check - User role:', req.user?.role, 'Required roles:', roles);

    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      console.log('Authorization failed - User role:', req.user.role, 'not in required roles:', roles);
      return res.status(403).json({
        message: 'Access denied. Insufficient permissions.',
        userRole: req.user.role,
        requiredRoles: roles
      });
    }

    console.log('Authorization successful');
    next();
  };
};

const checkModulePermission = (moduleName, action) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      // Super Admin has all permissions bypass
      if (req.user.role === 'super_admin') {
        console.log(`Permission check - Super Admin bypass for ${moduleName}.${action}`);
        return next();
      }

      console.log(`Permission check - Role: ${req.user.role}, Module: ${moduleName}, Action: ${action}`);

      // 1) Per-user permissions (highest priority)
      let modulePerms = null;
      const userPermission = await UserPermission.findOne({ user: req.user.id });
      if (userPermission && userPermission.permissions[moduleName]) {
        modulePerms = userPermission.permissions[moduleName];
        console.log(`Permission check - Using per-user permissions for user ${req.user.id}`);
      }
      // 2) Per-agency permissions (for agency_admin, agent, staff)
      if (!modulePerms && req.user.agency && ['agency_admin', 'agent', 'staff'].includes(req.user.role)) {
        const agencyPermission = await AgencyPermission.findOne({ agency: req.user.agency });
        if (agencyPermission && agencyPermission.permissions[moduleName]) {
          modulePerms = agencyPermission.permissions[moduleName];
          console.log(`Permission check - Using agency-specific permissions for agency ${req.user.agency}`);
        }
      }
      // 3) Role permissions (fallback)
      if (!modulePerms) {
        const rolePermission = await RolePermission.findOne({ role: req.user.role });
        if (!rolePermission) {
          console.log(`Permission check failed - No RolePermission found for role: ${req.user.role}`);
          return res.status(403).json({ message: `Access denied. No module permissions defined for role: ${req.user.role}` });
        }
        modulePerms = rolePermission.permissions[moduleName];
      }

      if (!modulePerms) {
        console.log(`Permission check failed - Module ${moduleName} not found in permissions`);
        return res.status(403).json({
          message: `Access denied. Module ${moduleName} not found in permissions.`,
          module: moduleName,
          action: action
        });
      }

      const hasPermission = modulePerms[action];
      console.log(`Permission check - ${moduleName}.${action} = ${hasPermission} (type: ${typeof hasPermission})`);

      if (hasPermission === true) {
        console.log(`Permission check passed - Role: ${req.user.role} can ${action} ${moduleName}`);
        return next();
      }

      console.log(`Permission denied - Role: ${req.user.role}, Module: ${moduleName}, Action: ${action}, Value: ${hasPermission}`);
      return res.status(403).json({
        message: `Access denied. You do not have permission to ${action} ${moduleName}.`,
        module: moduleName,
        action: action,
        hasPermission: hasPermission
      });
    } catch (error) {
      console.error('Permission check error:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({ message: 'Server error during permission check', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
  };
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    const user = await User.findById(decoded.userId);

    if (user && user.isActive) {
      req.user = {
        id: user._id.toString(),
        role: user.role,
        email: user.email,
        agency: user.agency ? user.agency.toString() : null
      };
    }

    next();
  } catch (error) {
    next();
  }
};

/**
 * Validates per-entry permissions on a document
 * @param {Object} document - The document (lead, user, etc) to check permissions for
 * @param {Object} user - The req.user object
 * @param {String} action - 'view', 'edit', 'delete'
 * @returns {Object} { allowed: boolean, reason: string }
 */
const validateEntryPermission = (document, user, action) => {
  // Super admin can do anything
  if (user.role === 'super_admin') {
    return { allowed: true, reason: 'super_admin_bypass' };
  }

  // Check per-entry granular permissions
  const granularPerms = document?.entryPermissions?.[user.role];
  
  // If entry has explicit false, deny
  if (granularPerms && granularPerms[action] === false) {
    return { allowed: false, reason: 'entry_explicit_deny' };
  }

  // If entry has explicit true, allow
  if (granularPerms && granularPerms[action] === true) {
    return { allowed: true, reason: 'entry_explicit_allow' };
  }

  // Otherwise, module-level permission has already been checked by middleware
  // If user reached the route handler, module permission already passed
  return { allowed: true, reason: 'module_permission_passed' };
};

/**
 * Validates agency isolation for a document
 * Ensures users can only access documents belonging to their agency
 */
const validateAgencyIsolation = (document, user) => {
  // Super admin can access all
  if (user.role === 'super_admin') {
    return { allowed: true, reason: 'super_admin_bypass' };
  }

  // For agency_admin and agents - must belong to user's agency
  if (!user.agency) {
    return { allowed: false, reason: 'user_no_agency' };
  }

  const docAgencyId = document?.agency?._id 
    ? document.agency._id.toString() 
    : (document?.agency?.toString() || document?.agency || null);

  const userAgencyId = user.agency?.toString ? user.agency.toString() : user.agency;

  if (docAgencyId !== userAgencyId) {
    return { allowed: false, reason: 'agency_mismatch', documentAgency: docAgencyId, userAgency: userAgencyId };
  }

  return { allowed: true, reason: 'agency_match' };
};

module.exports = { 
  auth, 
  authorize, 
  optionalAuth, 
  checkModulePermission,
  validateEntryPermission,
  validateAgencyIsolation
};
