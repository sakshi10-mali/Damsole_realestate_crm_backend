const express = require('express');
const { auth, authorize } = require('../middleware/auth');
const emailService = require('../services/emailService');
const User = require('../models/User');

const router = express.Router();

// @route   POST /api/test-email/welcome
// @desc    Test welcome email
// @access  Private (Super Admin)
router.post('/welcome', auth, authorize('super_admin'), async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        console.log('Test Email: Sending welcome email to:', user.email);
        await emailService.sendWelcomeEmail(user);

        res.json({
            message: 'Welcome email sent successfully',
            sentTo: user.email
        });
    } catch (error) {
        console.error('Test Email Error:', error);
        res.status(500).json({
            message: 'Failed to send email',
            error: error.message
        });
    }
});

// @route   POST /api/test-email/login
// @desc    Test login notification email
// @access  Private (Super Admin)
router.post('/login', auth, authorize('super_admin'), async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        console.log('Test Email: Sending login notification to:', user.email);
        await emailService.sendLoginNotificationEmail(user);

        res.json({
            message: 'Login notification sent successfully',
            sentTo: user.email
        });
    } catch (error) {
        console.error('Test Email Error:', error);
        res.status(500).json({
            message: 'Failed to send email',
            error: error.message
        });
    }
});

// @route   GET /api/test-email/status
// @desc    Get email service status
// @access  Private (Super Admin)
router.get('/status', auth, authorize('super_admin'), async (req, res) => {
    try {
        await emailService.ensureInitialized();

        res.json({
            message: 'Email service is initialized',
            configured: !!emailService.transporter
        });
    } catch (error) {
        res.status(500).json({
            message: 'Email service error',
            error: error.message
        });
    }
});

module.exports = router;
