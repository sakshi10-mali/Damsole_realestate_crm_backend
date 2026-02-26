const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { auth, authorize } = require('../middleware/auth');
const Lead = require('../models/Lead');
const Property = require('../models/Property');
const User = require('../models/User');
const Agency = require('../models/Agency');
const Transaction = require('../models/Transaction');
const Activity = require('../models/Activity');

const router = express.Router();

// @route   POST /api/backup/create
// @desc    Create database backup
// @access  Private (Super Admin only)
router.post('/create', auth, authorize('super_admin'), async (req, res) => {
  try {
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `backup-${timestamp}.json`;
    const backupPath = path.join(backupDir, backupFileName);

    // Export all collections
    const backup = {
      metadata: {
        createdAt: new Date(),
        createdBy: req.user.id,
        version: '1.0',
        database: mongoose.connection.name
      },
      data: {}
    };

    // Backup Leads
    const leads = await Lead.find({}).lean();
    backup.data.leads = leads;

    // Backup Properties
    const properties = await Property.find({}).lean();
    backup.data.properties = properties;

    // Backup Users (excluding passwords)
    const users = await User.find({}).select('-password').lean();
    backup.data.users = users;

    // Backup Agencies
    const agencies = await Agency.find({}).lean();
    backup.data.agencies = agencies;

    // Backup Transactions
    const transactions = await Transaction.find({}).lean();
    backup.data.transactions = transactions;

    // Backup Activities (last 1000)
    const activities = await Activity.find({}).sort({ createdAt: -1 }).limit(1000).lean();
    backup.data.activities = activities;

    // Write backup file
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

    // Log backup creation
    await Activity.create({
      type: 'other',
      entityType: 'other',
      entityId: new mongoose.Types.ObjectId(),
      title: 'Database backup created',
      description: `Backup file: ${backupFileName}`,
      performedBy: req.user.id,
      metadata: {
        backupFile: backupFileName,
        backupPath: backupPath,
        recordCounts: {
          leads: leads.length,
          properties: properties.length,
          users: users.length,
          agencies: agencies.length,
          transactions: transactions.length,
          activities: activities.length
        }
      }
    });

    res.json({
      message: 'Backup created successfully',
      backup: {
        fileName: backupFileName,
        path: backupPath,
        size: fs.statSync(backupPath).size,
        recordCounts: {
          leads: leads.length,
          properties: properties.length,
          users: users.length,
          agencies: agencies.length,
          transactions: transactions.length,
          activities: activities.length
        },
        createdAt: backup.metadata.createdAt
      }
    });
  } catch (error) {
    console.error('Backup creation error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/backup/list
// @desc    List all backups
// @access  Private (Super Admin only)
router.get('/list', auth, authorize('super_admin'), async (req, res) => {
  try {
    const backupDir = path.join(__dirname, '../../backups');
    
    if (!fs.existsSync(backupDir)) {
      return res.json({ backups: [] });
    }

    const files = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        return {
          fileName: file,
          size: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    res.json({ backups: files });
  } catch (error) {
    console.error('List backups error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/backup/restore
// @desc    Restore database from backup
// @access  Private (Super Admin only)
router.post('/restore', [
  auth,
  authorize('super_admin'),
  body('fileName').notEmpty().withMessage('Backup file name is required'),
  body('confirm').equals('RESTORE').withMessage('Must type RESTORE to confirm')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const backupDir = path.join(__dirname, '../../backups');
    const backupPath = path.join(backupDir, req.body.fileName);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ message: 'Backup file not found' });
    }

    // Read backup file
    const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    // Validate backup structure
    if (!backupData.data) {
      return res.status(400).json({ message: 'Invalid backup file format' });
    }

    // Restore data (in production, you'd want to do this more carefully)
    const restoreResults = {
      leads: 0,
      properties: 0,
      users: 0,
      agencies: 0,
      transactions: 0,
      activities: 0,
      errors: []
    };

    try {
      // Restore Leads
      if (backupData.data.leads && backupData.data.leads.length > 0) {
        await Lead.deleteMany({});
        await Lead.insertMany(backupData.data.leads);
        restoreResults.leads = backupData.data.leads.length;
      }
    } catch (error) {
      restoreResults.errors.push(`Leads: ${error.message}`);
    }

    try {
      // Restore Properties
      if (backupData.data.properties && backupData.data.properties.length > 0) {
        await Property.deleteMany({});
        await Property.insertMany(backupData.data.properties);
        restoreResults.properties = backupData.data.properties.length;
      }
    } catch (error) {
      restoreResults.errors.push(`Properties: ${error.message}`);
    }

    try {
      // Restore Agencies
      if (backupData.data.agencies && backupData.data.agencies.length > 0) {
        await Agency.deleteMany({});
        await Agency.insertMany(backupData.data.agencies);
        restoreResults.agencies = backupData.data.agencies.length;
      }
    } catch (error) {
      restoreResults.errors.push(`Agencies: ${error.message}`);
    }

    try {
      // Restore Transactions
      if (backupData.data.transactions && backupData.data.transactions.length > 0) {
        await Transaction.deleteMany({});
        await Transaction.insertMany(backupData.data.transactions);
        restoreResults.transactions = backupData.data.transactions.length;
      }
    } catch (error) {
      restoreResults.errors.push(`Transactions: ${error.message}`);
    }

    // Note: Users and Activities are not restored for security reasons
    // Users should be managed separately
    // Activities are historical logs

    // Log restore operation
    await Activity.create({
      type: 'other',
      entityType: 'other',
      entityId: new mongoose.Types.ObjectId(),
      title: 'Database restored from backup',
      description: `Restored from: ${req.body.fileName}`,
      performedBy: req.user.id,
      metadata: {
        backupFile: req.body.fileName,
        restoreResults: restoreResults
      }
    });

    res.json({
      message: 'Database restored successfully',
      restoreResults: restoreResults,
      restoredAt: new Date()
    });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   DELETE /api/backup/:fileName
// @desc    Delete backup file
// @access  Private (Super Admin only)
router.delete('/:fileName', auth, authorize('super_admin'), async (req, res) => {
  try {
    const backupDir = path.join(__dirname, '../../backups');
    const backupPath = path.join(backupDir, req.params.fileName);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ message: 'Backup file not found' });
    }

    fs.unlinkSync(backupPath);

    res.json({ message: 'Backup file deleted successfully' });
  } catch (error) {
    console.error('Delete backup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

