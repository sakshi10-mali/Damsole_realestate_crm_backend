const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const User = require('../models/User');
const { auth, authorize, checkModulePermission } = require('../middleware/auth');
const activityService = require('../services/activityService');

const router = express.Router();

// @route   GET /api/gdpr/export/:leadId
// @desc    Export lead data (GDPR Right to Data Portability)
// @access  Private
router.get('/export/:leadId', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.leadId)
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email')
      .populate('notes.createdBy', 'firstName lastName')
      .populate('communications.createdBy', 'firstName lastName')
      .populate('tasks.assignedTo', 'firstName lastName')
      .populate('reminders.createdBy', 'firstName lastName');

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    if (req.user.role === 'agency_admin' && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Export all lead data in JSON format
    const exportData = {
      leadId: lead.leadId,
      personalInformation: {
        firstName: lead.contact.firstName,
        lastName: lead.contact.lastName,
        email: lead.contact.email,
        phone: lead.contact.phone,
        alternatePhone: lead.contact.alternatePhone,
        address: lead.contact.address
      },
      inquiry: lead.inquiry,
      status: lead.status,
      priority: lead.priority,
      source: lead.source,
      campaignName: lead.campaignName,
      notes: lead.notes.map(note => ({
        note: note.note,
        createdAt: note.createdAt,
        createdBy: note.createdBy ? `${note.createdBy.firstName} ${note.createdBy.lastName}` : 'Unknown'
      })),
      communications: lead.communications.map(comm => ({
        type: comm.type,
        subject: comm.subject,
        message: comm.message,
        direction: comm.direction,
        createdAt: comm.createdAt,
        createdBy: comm.createdBy ? `${comm.createdBy.firstName} ${comm.createdBy.lastName}` : 'Unknown'
      })),
      tasks: lead.tasks.map(task => ({
        title: task.title,
        description: task.description,
        taskType: task.taskType,
        status: task.status,
        dueDate: task.dueDate,
        createdAt: task.createdAt
      })),
      reminders: lead.reminders.map(reminder => ({
        title: reminder.title,
        description: reminder.description,
        reminderDate: reminder.reminderDate,
        isCompleted: reminder.isCompleted,
        createdAt: reminder.createdAt
      })),
      siteVisit: lead.siteVisit,
      booking: lead.booking,
      metadata: {
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt,
        assignedAgent: lead.assignedAgent ? `${lead.assignedAgent.firstName} ${lead.assignedAgent.lastName}` : null,
        agency: lead.agency ? lead.agency.name : null
      }
    };

    // Log activity
    await activityService.logLeadActivity(
      lead,
      'other',
      req.user,
      'Lead data exported (GDPR)',
      { exportType: 'gdpr', exportedBy: req.user.id }
    );

    res.json({
      message: 'Lead data exported successfully',
      data: exportData,
      exportedAt: new Date().toISOString(),
      format: 'JSON'
    });
  } catch (error) {
    console.error('GDPR export error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/gdpr/delete/:leadId
// @desc    Delete lead data (GDPR Right to be Forgotten)
// @access  Private (Super Admin, Agency Admin)
router.delete('/delete/:leadId', auth, checkModulePermission('leads', 'delete'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    if (req.user.role === 'agency_admin' && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Anonymize lead data instead of hard delete (GDPR best practice)
    lead.contact = {
      firstName: '[DELETED]',
      lastName: '[DELETED]',
      email: `deleted_${lead._id}@deleted.local`,
      phone: '[DELETED]',
      alternatePhone: '[DELETED]',
      address: {}
    };
    lead.inquiry.message = '[DELETED]';
    lead.inquiry.requirements = '[DELETED]';
    lead.notes = [];
    lead.communications = [];
    lead.status = 'junk';
    lead.priority = 'Not_interested';
    lead.tags = ['GDPR_DELETED'];

    // Add deletion metadata
    lead.gdprDeleted = {
      deletedAt: new Date(),
      deletedBy: req.user.id,
      reason: 'GDPR Right to be Forgotten'
    };

    await lead.save();

    // Log activity
    await activityService.logLeadActivity(
      lead,
      'other',
      req.user,
      'Lead data deleted (GDPR Right to be Forgotten)',
      { deletionType: 'gdpr', deletedBy: req.user.id }
    );

    res.json({
      message: 'Lead data anonymized successfully (GDPR Right to be Forgotten)',
      leadId: lead.leadId
    });
  } catch (error) {
    console.error('GDPR delete error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/gdpr/consent/:leadId
// @desc    Record GDPR consent
// @access  Private
router.post('/consent/:leadId', [
  auth,
  checkModulePermission('leads', 'edit'),
  body('consentType').isIn(['marketing', 'data_processing', 'communication']).withMessage('Valid consent type is required'),
  body('consented').isBoolean().withMessage('Consented must be boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const lead = await Lead.findById(req.params.leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Initialize consent tracking if not exists
    if (!lead.gdprConsent) {
      lead.gdprConsent = {};
    }

    lead.gdprConsent[req.body.consentType] = {
      consented: req.body.consented,
      recordedAt: new Date(),
      recordedBy: req.user.id,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown'
    };

    await lead.save();

    // Log activity
    await activityService.logLeadActivity(
      lead,
      'other',
      req.user,
      `GDPR consent ${req.body.consented ? 'granted' : 'revoked'} for ${req.body.consentType}`,
      { consentType: req.body.consentType, consented: req.body.consented }
    );

    res.json({
      message: `Consent ${req.body.consented ? 'recorded' : 'revoked'} successfully`,
      consent: lead.gdprConsent[req.body.consentType]
    });
  } catch (error) {
    console.error('GDPR consent error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/gdpr/consent/:leadId
// @desc    Get GDPR consent status
// @access  Private
router.get('/consent/:leadId', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.leadId).select('gdprConsent contact');
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    res.json({
      leadId: lead.leadId,
      email: lead.contact.email,
      consent: lead.gdprConsent || {},
      hasConsent: lead.gdprConsent ? Object.keys(lead.gdprConsent).length > 0 : false
    });
  } catch (error) {
    console.error('Get GDPR consent error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

