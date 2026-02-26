const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Transaction = require('../models/Transaction');
const Property = require('../models/Property');
const { auth, authorize, checkModulePermission } = require('../middleware/auth');
const activityService = require('../services/activityService');

const router = express.Router();

// @route   POST /api/erp/sync-lead
// @desc    Sync lead data to ERP system
// @access  Private (Super Admin, Agency Admin)
router.post('/sync-lead', [
  auth,
  checkModulePermission('leads', 'edit'),
  body('leadId').isMongoId().withMessage('Valid lead ID is required'),
  body('erpSystem').isIn(['sap', 'oracle', 'tally', 'quickbooks', 'xero', 'custom']).withMessage('Valid ERP system is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const lead = await Lead.findById(req.body.leadId)
      .populate('property', 'title price')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName');

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Prepare ERP data format
    const erpData = {
      externalId: lead.leadId,
      customerName: `${lead.contact.firstName} ${lead.contact.lastName}`,
      email: lead.contact.email,
      phone: lead.contact.phone,
      address: lead.contact.address,
      status: lead.status,
      source: lead.source,
      campaign: lead.campaignName,
      property: lead.property ? {
        title: lead.property.title,
        price: lead.property.price
      } : null,
      booking: lead.booking ? {
        amount: lead.booking.bookingAmount,
        date: lead.booking.bookingDate,
        unitNumber: lead.booking.unitNumber
      } : null,
      agency: lead.agency ? lead.agency.name : null,
      assignedAgent: lead.assignedAgent ? `${lead.assignedAgent.firstName} ${lead.assignedAgent.lastName}` : null,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt
    };

    // In production, this would call the actual ERP API
    // For now, we'll simulate the sync
    const syncResult = {
      success: true,
      erpSystem: req.body.erpSystem,
      erpRecordId: `ERP-${Date.now()}`,
      syncedAt: new Date(),
      data: erpData
    };

    // Log sync activity
    await activityService.logLeadActivity(
      lead,
      'other',
      req.user,
      `Lead synced to ${req.body.erpSystem}`,
      { erpSystem: req.body.erpSystem, erpRecordId: syncResult.erpRecordId }
    );

    // Store ERP sync info in lead (if you add this field to model)
    if (!lead.erpSync) {
      lead.erpSync = [];
    }
    lead.erpSync.push({
      erpSystem: req.body.erpSystem,
      erpRecordId: syncResult.erpRecordId,
      syncedAt: syncResult.syncedAt,
      syncedBy: req.user.id
    });
    await lead.save();

    res.json({
      message: 'Lead synced to ERP system successfully',
      syncResult: syncResult
    });
  } catch (error) {
    console.error('ERP sync error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   POST /api/erp/sync-transaction
// @desc    Sync transaction to ERP system
// @access  Private (Super Admin, Agency Admin)
router.post('/sync-transaction', [
  auth,
  checkModulePermission('leads', 'edit'),
  body('transactionId').isMongoId().withMessage('Valid transaction ID is required'),
  body('erpSystem').isIn(['sap', 'oracle', 'tally', 'quickbooks', 'xero', 'custom']).withMessage('Valid ERP system is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const transaction = await Transaction.findById(req.body.transactionId)
      .populate('lead', 'leadId contact')
      .populate('property', 'title')
      .populate('agency', 'name');

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Prepare ERP transaction data
    const erpTransactionData = {
      externalId: transaction._id.toString(),
      leadId: transaction.lead?.leadId,
      customerName: transaction.lead ? `${transaction.lead.contact.firstName} ${transaction.lead.contact.lastName}` : 'Unknown',
      property: transaction.property ? transaction.property.title : null,
      amount: transaction.amount,
      currency: transaction.currency || 'USD',
      type: transaction.type,
      status: transaction.status,
      paymentMethod: transaction.paymentMethod,
      agency: transaction.agency ? transaction.agency.name : null,
      transactionDate: transaction.transactionDate || transaction.createdAt,
      createdAt: transaction.createdAt
    };

    // In production, this would call the actual ERP API
    const syncResult = {
      success: true,
      erpSystem: req.body.erpSystem,
      erpRecordId: `ERP-TXN-${Date.now()}`,
      syncedAt: new Date(),
      data: erpTransactionData
    };

    // Store ERP sync info in transaction
    if (!transaction.erpSync) {
      transaction.erpSync = [];
    }
    transaction.erpSync.push({
      erpSystem: req.body.erpSystem,
      erpRecordId: syncResult.erpRecordId,
      syncedAt: syncResult.syncedAt,
      syncedBy: req.user.id
    });
    await transaction.save();

    res.json({
      message: 'Transaction synced to ERP system successfully',
      syncResult: syncResult
    });
  } catch (error) {
    console.error('ERP transaction sync error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/erp/sync-status/:leadId
// @desc    Get ERP sync status for a lead
// @access  Private
router.get('/sync-status/:leadId', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.leadId).select('erpSync leadId');
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    res.json({
      leadId: lead.leadId,
      erpSync: lead.erpSync || [],
      isSynced: lead.erpSync && lead.erpSync.length > 0,
      lastSync: lead.erpSync && lead.erpSync.length > 0
        ? lead.erpSync[lead.erpSync.length - 1].syncedAt
        : null
    });
  } catch (error) {
    console.error('Get ERP sync status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/erp/webhook
// @desc    Receive data from ERP system (webhook)
// @access  Public (with API key validation)
router.post('/webhook', async (req, res) => {
  try {
    // Validate webhook API key
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const validApiKey = process.env.ERP_WEBHOOK_API_KEY;

    if (validApiKey && apiKey !== validApiKey) {
      return res.status(401).json({ message: 'Invalid API key' });
    }

    const webhookData = req.body;

    // Process ERP webhook data
    // This would typically update leads, transactions, or other entities based on ERP events

    res.json({
      success: true,
      message: 'ERP webhook received',
      receivedAt: new Date()
    });
  } catch (error) {
    console.error('ERP webhook error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

