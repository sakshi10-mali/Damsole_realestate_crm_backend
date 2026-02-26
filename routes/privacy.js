const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const User = require('../models/User');
const Lead = require('../models/Lead');
const Property = require('../models/Property');
const Transaction = require('../models/Transaction');

// @route   GET /api/privacy/export-data
// @desc    Export user data (GDPR right to data portability)
// @access  Private
router.get('/export-data', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Collect all user data
    const user = await User.findById(userId).select('-password');
    const leads = await Lead.find({ 
      $or: [
        { 'contact.email': user.email },
        { 'contact.phone': user.phone },
        { assignedAgent: userId }
      ]
    });
    const properties = await Property.find({ agent: userId });
    const transactions = await Transaction.find({ 
      $or: [
        { lead: { $in: leads.map(l => l._id) } },
        { property: { $in: properties.map(p => p._id) } }
      ]
    });

    const exportData = {
      user: {
        profile: {
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          role: user.role,
          createdAt: user.createdAt
        }
      },
      leads: leads.map(lead => ({
        leadId: lead.leadId,
        contact: lead.contact,
        status: lead.status,
        priority: lead.priority,
        createdAt: lead.createdAt
      })),
      properties: properties.map(prop => ({
        title: prop.title,
        status: prop.status,
        price: prop.price,
        createdAt: prop.createdAt
      })),
      transactions: transactions.map(trans => ({
        amount: trans.amount,
        status: trans.status,
        date: trans.date
      })),
      exportedAt: new Date()
    };

    res.json({
      success: true,
      data: exportData,
      message: 'Data exported successfully'
    });
  } catch (error) {
    console.error('Data export error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/privacy/delete-data
// @desc    Delete user data (GDPR right to be forgotten)
// @access  Private
router.delete('/delete-data', auth, [
  body('confirm').equals('DELETE').withMessage('Confirmation required')
], async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Anonymize leads
    await Lead.updateMany(
      { 'contact.email': user.email },
      {
        'contact.firstName': 'Deleted',
        'contact.lastName': 'User',
        'contact.email': `deleted_${Date.now()}@deleted.com`,
        'contact.phone': '0000000000'
      }
    );

    // Delete user account
    await User.findByIdAndDelete(userId);

    res.json({
      success: true,
      message: 'Data deleted successfully'
    });
  } catch (error) {
    console.error('Data deletion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/privacy/consent
// @desc    Get privacy consent status
// @access  Private
router.get('/consent', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('privacyConsent');
    res.json({
      consentGiven: user.privacyConsent?.given || false,
      consentDate: user.privacyConsent?.date,
      privacyPolicyVersion: user.privacyConsent?.version
    });
  } catch (error) {
    console.error('Get consent error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/privacy/consent
// @desc    Update privacy consent
// @access  Private
router.post('/consent', auth, [
  body('given').isBoolean().withMessage('Consent status is required')
], async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    user.privacyConsent = {
      given: req.body.given,
      date: new Date(),
      version: req.body.version || '1.0'
    };
    await user.save();

    res.json({
      success: true,
      message: 'Consent updated successfully'
    });
  } catch (error) {
    console.error('Update consent error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

