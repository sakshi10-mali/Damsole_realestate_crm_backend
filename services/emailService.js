require('dotenv').config();
const fs = require('fs');
const nodemailer = require('nodemailer');
const EmailTemplate = require('../models/EmailTemplate');
const Settings = require('../models/Settings');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
    this.initPromise = this.initialize();
  }

  async initialize() {
    if (this.initialized) return;

    try {
      console.log('EmailService: Initializing...');

      // Try to get configuration from database first
      let smtpHost, smtpPort, smtpUser, smtpPass, fromEmail, fromName;

      try {
        const dbSettings = await Settings.find({ category: 'email' });
        const config = {};
        dbSettings.forEach(s => {
          // Favor prefixed keys (e.g. "email.smtpHost") over non-prefixed ones
          // If a prefixed key is found, it will overwrite any non-prefixed version in our config object
          const isPrefixed = s.key.startsWith('email.');
          const fieldName = isPrefixed ? s.key.split('.')[1] : s.key;

          // Only overwrite if it's a prefixed key, or if we haven't set this field yet
          if (isPrefixed || !config[fieldName]) {
            config[fieldName] = s.value;
          }
        });

        smtpHost = config.smtpHost || process.env.SMTP_HOST;
        smtpPort = config.smtpPort || process.env.SMTP_PORT;
        smtpUser = config.smtpUser || process.env.SMTP_USER;
        smtpPass = config.smtpPass || process.env.SMTP_PASS;
        fromEmail = config.fromEmail || process.env.FROM_EMAIL;
        fromName = config.fromName || process.env.FROM_NAME;

        console.log('EmailService: Configuration loaded:', {
          host: smtpHost,
          port: smtpPort,
          user: smtpUser || 'NOT SET',
          passConfigured: !!smtpPass,
          source: config.smtpHost ? 'database' : 'environment'
        });
      } catch (dbError) {
        console.error('EmailService: Error fetching from database, using env fallback:', dbError.message);
        smtpHost = process.env.SMTP_HOST;
        smtpPort = process.env.SMTP_PORT;
        smtpUser = process.env.SMTP_USER;
        smtpPass = process.env.SMTP_PASS;
        fromEmail = process.env.FROM_EMAIL;
        fromName = process.env.FROM_NAME;
      }

      // Clean up inputs
      const safeSmtpHost = typeof smtpHost === 'string' ? smtpHost.trim() : smtpHost;
      const safeSmtpUser = typeof smtpUser === 'string' ? smtpUser.trim() : smtpUser;
      const safeSmtpPass = typeof smtpPass === 'string' ? smtpPass.trim() : smtpPass;

      // Validate critical configuration (No hardcoded defaults allowed)
      const missingParams = [];
      if (!safeSmtpHost) missingParams.push('SMTP_HOST');
      if (!smtpPort) missingParams.push('SMTP_PORT');
      if (!safeSmtpUser) missingParams.push('SMTP_USER');
      if (!safeSmtpPass) missingParams.push('SMTP_PASS');

      if (missingParams.length > 0) {
        const error = new Error(`Missing required email configuration: ${missingParams.join(', ')}`);
        error.code = 'MISSING_CONFIG';
        error.missingParams = missingParams;
        throw error;
      }

      this.smtpUser = safeSmtpUser;
      this.fromEmail = fromEmail || safeSmtpUser;
      this.fromName = fromName || 'SPIRELEAP Real Estate';

      this.transporter = nodemailer.createTransport({
        host: safeSmtpHost,
        port: parseInt(smtpPort),
        secure: parseInt(smtpPort) === 465,
        auth: {
          user: safeSmtpUser,
          pass: safeSmtpPass
        },
        // Add connection timeout options
        connectionTimeout: 60000, // 60 seconds for initial connection
        greetingTimeout: 30000,   // 30 seconds for SMTP greeting
        socketTimeout: 60000,     // 60 seconds for socket inactivity
        // Connection pool options
        pool: true,               // Use connection pooling
        maxConnections: 5,        // Maximum number of connections
        maxMessages: 100,         // Maximum messages per connection
        // Retry options
        retry: {
          attempts: 3,            // Retry 3 times
          delay: 2000             // Wait 2 seconds between retries
        },
        // TLS options for better compatibility
        tls: {
          rejectUnauthorized: false // Accept self-signed certificates if needed
        }
      });

      // Verify connection with timeout handling
      console.log('EmailService: Verifying SMTP connection...');
      try {
        await Promise.race([
          this.transporter.verify(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection verification timeout')), 60000)
          )
        ]);
        console.log('EmailService: ✓ SMTP connection verified successfully!');
      } catch (verifyError) {
        // Log warning but don't fail initialization if verify times out
        // Some SMTP servers may block verify() but still accept emails
        if (verifyError.code === 'ETIMEDOUT' || verifyError.message.includes('timeout')) {
          console.warn('EmailService: ⚠ SMTP verification timed out, but service may still work');
          console.warn('EmailService: Will attempt to send emails without pre-verification');
        } else {
          throw verifyError;
        }
      }

      this.initialized = true;
    } catch (error) {
      console.error('EmailService initialization error:', error.message);

      if (error.code === 'MISSING_CONFIG') {
        console.error('----------------------------------------------------------------');
        console.error('EmailService: 🛑 MISSING CONFIGURATION');
        console.error(`The following configuration parameters are missing: ${error.missingParams.join(', ')}`);
        console.error('Please configure them in the Super Admin Settings UI or .env file.');
        console.error('----------------------------------------------------------------');
      } else if (error.responseCode === 535) {
        console.error('----------------------------------------------------------------');
        console.error('EmailService: 🛑 AUTHENTICATION FAILED (535)');
        console.error('Check your SMTP User and Password.');
        console.error('----------------------------------------------------------------');
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
        console.error('----------------------------------------------------------------');
        console.error('EmailService: 🛑 CONNECTION TIMEOUT/REFUSED');
        console.error(`Error: ${error.message}`);
        console.error('Possible causes:');
        console.error('1. SMTP host/port is incorrect');
        console.error('2. Firewall blocking SMTP connections');
        console.error('3. SMTP server is down or unreachable');
        console.error('4. Network connectivity issues');
        console.error(`Current config: ${safeSmtpHost}:${smtpPort}`);
        console.error('----------------------------------------------------------------');
      }

      this.initialized = false;
      this.transporter = null;
      // Rethrow to ensure initPromise rejects
      throw error;
    }
  }

  async ensureInitialized() {
    try {
      if (this.initPromise) {
        await this.initPromise;
      }
      if (!this.transporter || !this.initialized) {
        throw new Error('Email service not properly initialized');
      }
    } catch (error) {
      // Re-throw so callers know initialization failed
      throw error;
    }
  }

  async reinitialize() {
    console.log('EmailService: Forcing reinitialization...');
    this.initialized = false;
    this.transporter = null;
    this.initPromise = this.initialize();
    await this.initPromise;
    console.log('EmailService: Reinitialization complete');
  }

  /**
   * Loads a template from DB or falls back to hardcoded generator
   * @param {string} slug Template slug
   * @param {Object} variables Variables to replace
   * @param {Function} fallbackGenerator Function that returns {html, text, subject}
   */
  async getTemplate(slug, variables, fallbackGenerator) {
    try {
      const template = await EmailTemplate.findOne({ slug, isActive: true });
      if (template) {
        let html = template.htmlContent;
        let text = template.textContent || '';
        let subject = template.subject;

        // Simple variable replacement: {{variableName}}
        Object.entries(variables).forEach(([key, value]) => {
          const regex = new RegExp(`{{${key}}}`, 'g');
          html = html.replace(regex, value || '');
          text = text.replace(regex, value || '');
          subject = subject.replace(regex, value || '');
        });

        return { html, text, subject };
      }
    } catch (error) {
      console.error(`Error loading template ${slug}:`, error);
    }

    // Fallback if not found or error
    return fallbackGenerator();
  }

  async sendPasswordResetEmail(user, resetToken) {
    await this.ensureInitialized();
    try {
      const resetUrl = `${process.env.CLIENT_URL}/auth/reset-password?token=${resetToken}`;
      const variables = {
        firstName: user.firstName,
        lastName: user.lastName,
        resetUrl: resetUrl
      };

      const { html, text, subject } = await this.getTemplate('password-reset', variables, () => ({
        html: this.generatePasswordResetHTML(user, resetUrl),
        text: this.generatePasswordResetText(user, resetUrl),
        subject: 'Password Reset Request'
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: user.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Password reset email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending password reset email:', error);
      throw error;
    }
  }

  async sendWelcomeEmail(user) {
    await this.ensureInitialized();
    try {
      // Check if global email notifications are enabled
      const emailSetting = await Settings.findOne({ key: 'notifications.emailNotifications' });
      const areEmailsEnabled = emailSetting ? emailSetting.value : true;

      if (!areEmailsEnabled) {
        console.log('EmailService: Global email notifications are disabled, skipping welcome email for:', user.email);
        return { message: 'Notifications disabled' };
      }

      console.log('EmailService: sendWelcomeEmail called for:', user.email);

      const variables = {
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.charAt(0).toUpperCase() + user.role.slice(1),
        loginUrl: `${process.env.CLIENT_URL}/auth/login`
      };

      const { html, text, subject } = await this.getTemplate('welcome-email', variables, () => ({
        html: this.generateWelcomeEmailHTML(user),
        text: this.generateWelcomeEmailText(user),
        subject: 'Welcome to SPIRELEAP Real Estate CRM'
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: user.email,
        subject,
        html,
        text
      };

      console.log('EmailService: Sending welcome email to:', user.email);
      const result = await this.transporter.sendMail(mailOptions);
      console.log('EmailService: ✓ Welcome email sent successfully! MessageId:', result.messageId);
      return result;
    } catch (error) {
      console.error('EmailService: ✗ Error sending welcome email:', error.message);
      throw error;
    }
  }

  generatePasswordResetHTML(user, resetUrl) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Password Reset Request</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Password Reset Request</h1>
          <p>Dear ${user.firstName} ${user.lastName},</p>
          <p>You have requested to reset your password for your SPIRELEAP Real Estate CRM account.</p>
          <p>Click the button below to reset your password:</p>
          <a href="${resetUrl}" class="button">Reset Password</a>
          <p>This link will expire in 1 hour for security reasons.</p>
          <p>If you didn't request this password reset, please ignore this email.</p>
          <p>Best regards,<br>SPIRELEAP Real Estate Team</p>
        </div>
      </body>
      </html>
    `;
  }

  generatePasswordResetText(user, resetUrl) {
    return `
Password Reset Request

Dear ${user.firstName} ${user.lastName},

You have requested to reset your password for your Alvasco Procurement System account.

Click the link below to reset your password:
${resetUrl}

This link will expire in 1 hour for security reasons.

If you didn't request this password reset, please ignore this email.

Best regards,
SPIRELEAP Real Estate Team
    `;
  }

  async sendAccountCreatedNotification(user, password) {
    console.log('📧 [EmailService] sendAccountCreatedNotification called for:', user.email);
    await this.ensureInitialized();
    console.log('📧 [EmailService] Email service initialized successfully');
    try {
      const variables = {
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.charAt(0).toUpperCase() + user.role.slice(1),
        agencyName: user.agency?.name || 'SPIRELEAP',
        email: user.email,
        password: password,
        loginUrl: `${process.env.CLIENT_URL}/auth/login`
      };

      console.log('📧 [EmailService] Email variables prepared:', {
        to: variables.email,
        role: variables.role,
        agency: variables.agencyName,
        hasPassword: !!password
      });

      const { html, text, subject } = await this.getTemplate('account-created', variables, () => ({
        html: this.generateAccountCreatedHTML(user, password),
        text: this.generateAccountCreatedText(user, password),
        subject: 'Your SPIRELEAP CRM Account Credentials'
      }));

      console.log('📧 [EmailService] Email template generated, subject:', subject);

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: user.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ [EmailService] Account creation email sent successfully! MessageId:', result.messageId);
      return result;
    } catch (error) {
      console.error('❌ [EmailService] Error sending account creation email:', error);
      console.error('❌ [EmailService] Error details:', {
        message: error.message,
        code: error.code,
        response: error.response
      });
      throw error;
    }
  }

  generateAccountCreatedHTML(user, password) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Account Created - SPIRELEAP CRM</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2c5aa0; color: white; padding: 20px; border-radius: 5px; text-align: center; }
          .content { padding: 20px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 5px 5px; }
          .creds { background: #f4f4f4; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Welcome to SPIRELEAP CRM</h1>
          </div>
          <div class="content">
            <p>Dear ${user.firstName} ${user.lastName},</p>
            <p>An administrator has created your account on the SPIRELEAP Real Estate CRM.</p>
            <p><strong>Account Details:</strong></p>
            <ul>
              <li><strong>Role:</strong> ${user.role.charAt(0).toUpperCase() + user.role.slice(1)}</li>
              <li><strong>Agency:</strong> ${user.agency?.name || 'SPIRELEAP'}</li>
            </ul>
            <div class="creds">
              <p style="margin-top: 0;"><strong>Your Login Credentials:</strong></p>
              <p><strong>Email:</strong> ${user.email}</p>
              <p><strong>Password:</strong> ${password}</p>
            </div>
            <p style="color: #666; font-size: 14px;">Please change your password after your first login for better security.</p>
            <div style="text-align: center;">
              <a href="${process.env.CLIENT_URL}/auth/login" class="button">Login Now</a>
            </div>
            <p>Best regards,<br>SPIRELEAP Real Estate Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateAccountCreatedText(user, password) {
    return `
Welcome to SPIRELEAP Real Estate CRM!

Dear ${user.firstName} ${user.lastName},

An administrator has created your account on the SPIRELEAP Real Estate CRM.

Account Details:
- Role: ${user.role.charAt(0).toUpperCase() + user.role.slice(1)}
- Agency: ${user.agency?.name || 'SPIRELEAP'}

Your Login Credentials:
- Email: ${user.email}
- Password: ${password}

Please change your password after your first login for better security.

Login here: ${process.env.CLIENT_URL}/auth/login

Best regards,
SPIRELEAP Real Estate Team
    `;
  }

  generateWelcomeEmailHTML(user) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Welcome to SPIRELEAP Real Estate CRM</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f7f6; }
          .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
          .header { background: linear-gradient(135deg, #2c5aa0 0%, #1e3a6d 100%); color: white; padding: 40px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 28px; font-weight: 600; letter-spacing: 1px; }
          .content { padding: 40px 30px; }
          .welcome-text { font-size: 18px; color: #2c5aa0; font-weight: 600; margin-bottom: 10px; }
          .role-badge { display: inline-block; background: #eef2f7; color: #2c5aa0; padding: 4px 12px; border-radius: 20px; font-size: 14px; font-weight: 600; margin: 10px 0; }
          .features { margin: 25px 0; padding: 0; list-style: none; }
          .feature-item { margin-bottom: 12px; display: flex; align-items: flex-start; }
          .feature-icon { color: #2c5aa0; margin-right: 10px; font-weight: bold; }
          .btn-container { text-align: center; margin: 35px 0; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; transition: background 0.3s; box-shadow: 0 4px 6px rgba(44, 90, 160, 0.2); }
          .footer { background: #f9f9f9; padding: 25px; text-align: center; font-size: 13px; color: #777; border-top: 1px solid #eee; }
          .social-links { margin-top: 15px; }
          .social-links a { color: #2c5aa0; text-decoration: none; margin: 0 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to SPIRELEAP</h1>
          </div>
          <div class="content">
            <p class="welcome-text">Hi ${user.firstName} ${user.lastName},</p>
            <p>Welcome to the SPIRELEAP Real Estate CRM! We're excited to have you on board. Your account has been successfully created and is ready for use.</p>
            
            <div class="role-badge">Role: ${user.role.charAt(0).toUpperCase() + user.role.slice(1).replace('_', ' ')}</div>
            
            <p>With SPIRELEAP, you can now:</p>
            <ul class="features">
              <li class="feature-item"><span class="feature-icon">✓</span> Manage your real estate leads efficiently</li>
              <li class="feature-item"><span class="feature-icon">✓</span> Track property listings and inquiries</li>
              <li class="feature-item"><span class="feature-icon">✓</span> Collaborate with your team members</li>
              <li class="feature-item"><span class="feature-icon">✓</span> Access powerful analytics and reports</li>
            </ul>
            
            <div class="btn-container">
              <a href="${process.env.CLIENT_URL}/auth/login" class="button">Access Your Dashboard</a>
            </div>
            
            <p>If you have any questions, our support team is always here to help.</p>
            <p>Best regards,<br><strong>SPIRELEAP Real Estate Team</strong></p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} SPIRELEAP Real Estate CRM. All rights reserved.</p>
            <div class="social-links">
              <a href="#">Website</a> | <a href="#">Support</a> | <a href="#">Privacy Policy</a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateWelcomeEmailText(user) {
    return `
Welcome to SPIRELEAP Real Estate CRM!

Dear ${user.firstName} ${user.lastName},

Welcome to the SPIRELEAP Real Estate CRM! Your account has been successfully created.

Your role: ${user.role.charAt(0).toUpperCase() + user.role.slice(1)}

You can now access the system and start using all the features available to your role.

Login to the system: ${process.env.CLIENT_URL}/auth/login

If you have any questions or need assistance, please don't hesitate to contact our support team.

Best regards,
SPIRELEAP Real Estate Team
    `;
  }

  async sendLoginNotificationEmail(user) {
    await this.ensureInitialized();
    try {
      // Check if login alerts are enabled in settings
      const alertSetting = await Settings.findOne({ key: 'notifications.loginAlerts' });
      const areAlertsEnabled = alertSetting ? alertSetting.value : true; // Default to true if not set

      if (!areAlertsEnabled) {
        console.log('EmailService: Login alerts are disabled in settings, skipping email for:', user.email);
        return { message: 'Alerts disabled' };
      }

      console.log('EmailService: sendLoginNotificationEmail called for:', user.email);

      const now = new Date();
      const loginTime = now.toLocaleString('en-US', {
        dateStyle: 'full',
        timeStyle: 'long'
      });

      const variables = {
        firstName: user.firstName,
        lastName: user.lastName,
        loginTime: loginTime,
        ipAddress: '', // Can be passed if available
        device: '' // Can be passed if available
      };

      const { html, text, subject } = await this.getTemplate('login-notification', variables, () => ({
        html: this.generateLoginNotificationHTML(user, loginTime),
        text: this.generateLoginNotificationText(user, loginTime),
        subject: 'New Login to Your SPIRELEAP Account'
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: user.email,
        subject,
        html,
        text
      };

      console.log('EmailService: Sending login notification to:', user.email);
      const result = await this.transporter.sendMail(mailOptions);
      console.log('EmailService: ✓ Login notification sent successfully! MessageId:', result.messageId);
      return result;
    } catch (error) {
      console.error('EmailService: ✗ Error sending login notification:', error.message);
      throw error;
    }
  }

  generateLoginNotificationHTML(user, loginTime) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Login Notification</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f7f6; }
          .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
          .header { background: #2c5aa0; color: white; padding: 30px 20px; text-align: center; }
          .header h2 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 40px 30px; }
          .security-info { background: #fff9e6; border-left: 4px solid #ffcc00; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .details-box { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 25px 0; }
          .details-row { display: flex; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 8px; }
          .details-label { width: 100px; font-weight: 600; color: #666; }
          .details-value { flex: 1; color: #333; }
          .btn-container { text-align: center; margin: 30px 0; }
          .button { display: inline-block; background: #d32f2f; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; }
          .footer { padding: 25px; text-align: center; font-size: 13px; color: #777; border-top: 1px solid #eee; background: #f9f9f9; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>New Login Detected</h2>
          </div>
          <div class="content">
            <p>Dear ${user.firstName} ${user.lastName},</p>
            <p>This is an automated security notification to inform you that your SPIRELEAP Real Estate CRM account was just logged into.</p>
            
            <div class="details-box">
              <div class="details-row">
                <div class="details-label">Time</div>
                <div class="details-value">${loginTime}</div>
              </div>
              <div class="details-row">
                <div class="details-label">Status</div>
                <div class="details-value">Successful Login</div>
              </div>
            </div>

            <div class="security-info">
              <p style="margin: 0;"><strong>If this was you:</strong> You can safely ignore this email.</p>
            </div>

            <div class="security-info" style="background: #fee; border-color: #d32f2f;">
              <p style="margin: 0;"><strong>If this was NOT you:</strong> Your account security may be compromised. Please take immediate action to secure your account.</p>
            </div>

            <div class="btn-container">
              <a href="${process.env.CLIENT_URL}/auth/forgot-password" class="button">Secure My Account Now</a>
            </div>
            
            <p>For your security, we recommend using a strong, unique password for your CRM account.</p>
            <p>Best regards,<br><strong>SPIRELEAP Real Estate Team</strong></p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} SPIRELEAP Real Estate Team. All rights reserved.</p>
            <p>This is an automated security alert. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateLoginNotificationText(user, loginTime) {
    return `
Login Notification - SPIRELEAP Real Estate CRM

Dear ${user.firstName} ${user.lastName},

We detected a new login to your SPIRELEAP Real Estate CRM account.

Time: ${loginTime}

If this was you, you can safely ignore this email.

If you did not log in, please secure your account by resetting your password immediately:
${process.env.CLIENT_URL}/auth/forgot-password

Best regards,
SPIRELEAP Real Estate Team
    `;
  }

  /**
   * @param {Object} transaction - Populated transaction (lead, property, agency)
   * @param {{ invoicePdfBuffer?: Buffer, fileName?: string }} opts - Invoice PDF attachment (same as customer portal download)
   */
  async sendBookingFinalizedEmail(transaction, opts = {}) {
    await this.ensureInitialized();
    try {
      if (!transaction.lead?.contact?.email) {
        console.log('Customer email not available for booking finalization email');
        return null;
      }

      const variables = {
        firstName: transaction.lead.contact.firstName,
        lastName: transaction.lead.contact.lastName,
        propertyTitle: transaction.property?.title || 'Property',
        amount: Number(transaction.amount || 0).toLocaleString(),
        transactionDate: new Date(transaction.transactionDate).toLocaleDateString(),
        paymentMethod: (transaction.paymentMethod || 'Other').replace('_', ' ').toUpperCase(),
        dealType: (transaction.type || 'sale').toUpperCase(),
        agencyName: transaction.agency?.name || 'SPIRELEAP',
        unitNumber: transaction.erpSync?.unitNumber || 'N/A'
      };

      const { html, text, subject } = await this.getTemplate('booking-finalized', variables, () => ({
        html: this.generateBookingFinalizedHTML(variables),
        text: this.generateBookingFinalizedText(variables),
        subject: `Property Finalized: ${variables.propertyTitle}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: transaction.lead.contact.email,
        subject,
        html,
        text
      };

      if (opts.invoicePdfBuffer && Buffer.isBuffer(opts.invoicePdfBuffer)) {
        mailOptions.attachments = [
          {
            filename: opts.fileName || 'invoice.pdf',
            content: opts.invoicePdfBuffer
          }
        ];
      }

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Booking finalized email sent (with invoice attachment):', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending booking finalized email:', error);
      throw error;
    }
  }

  generateBookingFinalizedHTML(v) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Booking Finalized</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; background-color: #f9fafb; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
          .header { background: #10b981; color: white; padding: 30px; text-align: center; }
          .content { padding: 40px; }
          .details-box { background: #f3f4f6; padding: 25px; border-radius: 8px; margin: 25px 0; }
          .detail-row { display: flex; justify-content: space-between; margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
          .detail-label { color: #6b7280; font-weight: 500; font-size: 14px; }
          .detail-value { color: #111827; font-weight: 600; font-size: 14px; }
          .footer { text-align: center; padding: 25px; font-size: 13px; color: #9ca3af; border-top: 1px solid #f3f4f6; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin:0; font-size: 24px;">🎉 Booking Finalized!</h1>
          </div>
          <div class="content">
            <p>Dear ${v.firstName} ${v.lastName},</p>
            <p>We are excited to inform you that your booking for <strong>${v.propertyTitle}</strong> has been finalized by ${v.agencyName}.</p>
            
            <div class="details-box">
              <h3 style="margin-top:0; color: #111827;">Booking Details</h3>
              <div class="detail-row">
                <span class="detail-label">Property</span>
                <span class="detail-value">${v.propertyTitle}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Deal Type</span>
                <span class="detail-value">${v.dealType}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount</span>
                <span class="detail-value">₹${v.amount}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Payment Method</span>
                <span class="detail-value">${v.paymentMethod}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Unit/Flat No.</span>
                <span class="detail-value">${v.unitNumber}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date</span>
                <span class="detail-value">${v.transactionDate}</span>
              </div>
            </div>
            
            <p>Your invoice is attached to this email. You can also view and download it anytime from your customer dashboard.</p>
            <p>Congratulations once again on your new property!</p>
            <p>Best regards,<br><strong>${v.agencyName} Team</strong></p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${v.agencyName}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateBookingFinalizedText(v) {
    return `
Booking Finalized!

Dear ${v.firstName} ${v.lastName},

Congratulations! Your booking for ${v.propertyTitle} has been finalized by ${v.agencyName}.

Booking Details:
- Property: ${v.propertyTitle}
- Deal Type: ${v.dealType}
- Amount: ₹${v.amount}
- Payment Method: ${v.paymentMethod}
- Unit/Flat No.: ${v.unitNumber}
- Date: ${v.transactionDate}

Your invoice is attached to this email.

Best regards,
${v.agencyName} Team
    `;
  }

  async sendNewLeadNotification(lead, agent, agency) {
    await this.ensureInitialized();
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for lead notification');
        return null;
      }

      const variables = {
        agentFirstName: agent.firstName,
        agentLastName: agent.lastName,
        leadFirstName: lead.contact.firstName,
        leadLastName: lead.contact.lastName,
        leadEmail: lead.contact.email,
        leadPhone: lead.contact.phone,
        propertyTitle: lead.property?.title || 'General Inquiry',
        leadStatus: lead.status,
        leadPriority: lead.priority,
        leadMessage: lead.inquiry?.message || '',
        agencyName: agency?.name || 'SPIRELEAP',
        leadUrl: `${process.env.CLIENT_URL}/agency/leads/${lead._id}`
      };

      const { html, text, subject } = await this.getTemplate('new-lead-notification', variables, () => ({
        html: this.generateLeadNotificationHTML(lead, agent, agency),
        text: this.generateLeadNotificationText(lead, agent, agency),
        subject: `New Lead Assigned: ${lead.contact.firstName} ${lead.contact.lastName}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Lead notification email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending lead notification email:', error);
      throw error;
    }
  }

  async sendLeadAssignmentNotification(lead, agent, agency) {
    await this.ensureInitialized();
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for assignment notification');
        return null;
      }

      const variables = {
        agentFirstName: agent.firstName,
        agentLastName: agent.lastName,
        leadFirstName: lead.contact.firstName,
        leadLastName: lead.contact.lastName,
        leadEmail: lead.contact.email,
        leadPhone: lead.contact.phone,
        propertyTitle: lead.property?.title || 'General Inquiry',
        leadStatus: lead.status,
        leadPriority: lead.priority,
        leadMessage: lead.inquiry?.message || '',
        agencyName: agency?.name || 'SPIRELEAP',
        leadUrl: `${process.env.CLIENT_URL}/agency/leads/${lead._id}`
      };

      const { html, text, subject } = await this.getTemplate('lead-assignment-notification', variables, () => ({
        html: this.generateLeadAssignmentHTML(lead, agent, agency),
        text: this.generateLeadAssignmentText(lead, agent, agency),
        subject: `Lead Assigned to You: ${lead.contact.firstName} ${lead.contact.lastName}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Lead assignment email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending lead assignment email:', error);
      throw error;
    }
  }

  async sendContactAgentRequest(lead, agent, agency) {
    await this.ensureInitialized();
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for contact request notification');
        return null;
      }

      const variables = {
        agentFirstName: agent.firstName,
        agentLastName: agent.lastName,
        leadFirstName: lead.contact.firstName,
        leadLastName: lead.contact.lastName,
        leadEmail: lead.contact.email,
        leadPhone: lead.contact.phone,
        propertyTitle: lead.property?.title || 'General Inquiry',
        agencyName: agency?.name || 'SPIRELEAP',
        leadUrl: `${process.env.CLIENT_URL}/agency/leads/${lead._id}`
      };

      const { html, text, subject } = await this.getTemplate('contact-agent-request', variables, () => ({
        html: this.generateContactAgentRequestHTML(lead, agent, agency),
        text: this.generateContactAgentRequestText(lead, agent, agency),
        subject: `ACTION REQUIRED: Customer Contact Request - ${lead.contact.firstName} ${lead.contact.lastName}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Contact agent request email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending contact agent request email:', error);
      throw error;
    }
  }

  async sendContactConfirmation(contactMessage) {
    await this.ensureInitialized();
    try {
      if (!contactMessage || !contactMessage.email) {
        console.log('Contact email not available for confirmation');
        return null;
      }

      // Populate agency if it's just an ID
      let agencyName = 'SPIRELEAP';
      if (contactMessage.agency && contactMessage.agency.name) {
        agencyName = contactMessage.agency.name;
      }

      const firstName = contactMessage.name.split(' ')[0] || contactMessage.name;

      const variables = {
        firstName: firstName,
        lastName: '',
        propertyTitle: contactMessage.subject || 'General Inquiry',
        agencyName: agencyName
      };

      const { html, text, subject } = await this.getTemplate('inquiry-confirmation', variables, () => ({
        html: this.generateContactConfirmationHTML(contactMessage, agencyName, firstName),
        text: this.generateContactConfirmationText(contactMessage, agencyName, firstName),
        subject: `Thank you for contacting us: ${variables.propertyTitle}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: contactMessage.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Contact confirmation email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending contact confirmation email:', error);
      return null;
    }
  }

  generateContactConfirmationHTML(contactMessage, agencyName, firstName) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Message Received</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; text-align: center; }
          .content { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .footer { text-align: center; font-size: 12px; color: #777; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Thank You for Your Message</h1>
          </div>
          
          <div class="content">
            <p>Dear ${firstName},</p>
            <p>Thank you for contacting ${agencyName}. We have received your message regarding "<strong>${contactMessage.subject || 'General Inquiry'}</strong>".</p>
            
            <p>Our team has been notified and someone will connect with you soon.</p>
            
            <p>If you have any urgent questions, please feel free to contact us directly.</p>
            
            <p>Best regards,<br>
            ${agencyName} Team</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${agencyName}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateContactConfirmationText(contactMessage, agencyName, firstName) {
    return `
Thank You for Your Message

Dear ${firstName},

Thank you for contacting ${agencyName}. We have received your message regarding "${contactMessage.subject || 'General Inquiry'}".

Our team has been notified and someone will connect with you soon.

Best regards,
${agencyName} Team
    `;
  }


  async sendInquiryConfirmation(lead) {
    await this.ensureInitialized();
    try {
      if (!lead || !lead.contact || !lead.contact.email) {
        console.log('Lead email not available for confirmation');
        return null;
      }

      const variables = {
        firstName: lead.contact.firstName,
        lastName: lead.contact.lastName,
        propertyTitle: lead.property?.title || 'General Inquiry',
        agencyName: lead.agency?.name || 'SPIRELEAP'
      };

      const { html, text, subject } = await this.getTemplate('inquiry-confirmation', variables, () => ({
        html: this.generateInquiryConfirmationHTML(lead),
        text: this.generateInquiryConfirmationText(lead),
        subject: `Thank you for your inquiry: ${variables.propertyTitle}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: lead.contact.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Inquiry confirmation email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending inquiry confirmation email:', error);
      // Don't throw, just log error so we don't block other notifications
      return null;
    }
  }

  generateInquiryConfirmationHTML(lead) {
    const agencyName = lead.agency?.name || 'SPIRELEAP';
    const propertyTitle = lead.property?.title || 'Property';
    const propertyLink = lead.property?.slug ? `${process.env.CLIENT_URL}/properties/${lead.property.slug}` : null;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f7f6; }
          .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
          .header { background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; padding: 40px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 40px 30px; }
          .greeting { font-size: 18px; color: #1e3a8a; font-weight: 600; margin-bottom: 20px; }
          .property-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 25px 0; }
          .property-title { font-weight: 700; color: #1e293b; margin-bottom: 5px; }
          .button { display: inline-block; background: #3b82f6; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 20px; }
          .footer { background: #f9fafb; padding: 30px; text-align: center; font-size: 13px; color: #64748b; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Inquiry Received</h1>
          </div>
          <div class="content">
            <p class="greeting">Hello ${lead.contact.firstName},</p>
            <p>Thank you for reaching out to <strong>${agencyName}</strong>. We've received your inquiry and our team is already on it!</p>
            
            <div class="property-card">
              <p style="margin: 0; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px;">Property of Interest</p>
              <h3 class="property-title">${propertyTitle}</h3>
              ${propertyLink ? `<a href="${propertyLink}" style="color: #3b82f6; font-size: 14px; text-decoration: none;">View Property Details &rarr;</a>` : ''}
            </div>

            <p>One of our dedicated agents will review your request and contact you shortly with the information you need.</p>
            
            <p>In the meantime, feel free to browse more listings on our website or reply to this email if you have any immediate questions.</p>
            
            <p>Best regards,<br><strong>${agencyName} Team</strong></p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${agencyName}. All rights reserved.</p>
            <p>You received this email because you submitted an inquiry on our website.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateInquiryConfirmationText(lead) {
    const propertyInfo = lead.property ? `You requested information about ${lead.property.title}.` : 'Thank you for your general inquiry.';
    const agencyName = lead.agency?.name || 'SPIRELEAP';

    return `
Thank You for Your Inquiry

Dear ${lead.contact.firstName},

Thank you for contacting ${agencyName}. We have received your inquiry.

${propertyInfo}

One of our agents will review your request and get back to you shortly.

Best regards,
${agencyName} Team
    `;
  }

  generateLeadNotificationHTML(lead, agent, agency) {
    const propertyTitle = lead.property?.title || 'General Property Inquiry';
    const propertyLink = lead.property?.slug ? `${process.env.CLIENT_URL}/properties/${lead.property.slug}` : null;
    const leadUrl = `${process.env.CLIENT_URL}/agency/leads/${lead._id}`;
    const agencyName = agency?.name || 'SPIRELEAP';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f1f5f9; }
          .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
          .header { background: #0f172a; color: white; padding: 30px; text-align: center; }
          .badge { display: inline-block; padding: 4px 12px; background: #3b82f6; color: white; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 10px; }
          .content { padding: 40px 30px; }
          .lead-info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 25px; margin: 20px 0; }
          .info-row { display: flex; margin-bottom: 15px; border-bottom: 1px solid #f1f5f9; padding-bottom: 10px; }
          .info-label { width: 100px; font-weight: 600; color: #64748b; font-size: 14px; }
          .info-value { flex: 1; color: #1e293b; font-weight: 500; }
          .btn-container { text-align: center; margin-top: 30px; }
          .button { display: inline-block; background: #1e3a8a; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; }
          .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 13px; color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="badge">New Lead • ${lead.priority || 'Warm'}</div>
            <h1 style="margin: 0; font-size: 20px;">New Inquiry: ${propertyTitle}</h1>
          </div>
          <div class="content">
            <p>Dear Team,</p>
            <p>A new property inquiry has been received. Please review the customer details below and action accordingly.</p>
            
            <div class="lead-info-box">
              <div class="info-row">
                <div class="info-label">Customer</div>
                <div class="info-value">${lead.contact.firstName} ${lead.contact.lastName}</div>
              </div>
              <div class="info-row">
                <div class="info-label">Email</div>
                <div class="info-value">${lead.contact.email}</div>
              </div>
              <div class="info-row">
                <div class="info-label">Phone</div>
                <div class="info-value">${lead.contact.phone || 'Not provided'}</div>
              </div>
              <div class="info-row">
                <div class="info-label">Property</div>
                <div class="info-value">${propertyTitle}</div>
              </div>
              ${lead.inquiry?.message ? `
              <div class="info-row" style="border-bottom: none;">
                <div class="info-label">Message</div>
                <div class="info-value" style="font-style: italic; color: #475569;">"${lead.inquiry.message}"</div>
              </div>` : ''}
            </div>

            <div style="margin-top: 30px; font-size: 14px; color: #64748b;">Prompt contact increases conversion rates by up to 300%. We recommend responding within 60 minutes.</div>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${agencyName} Internal Notification</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateLeadNotificationText(lead, agent, agency) {
    const propertyInfo = lead.property ? `Property: ${lead.property.title}` : 'Type: General Inquiry';

    return `
New Lead Assigned

Dear ${agent.firstName} ${agent.lastName},

A new lead has been assigned to you.

Lead Information:
- Name: ${lead.contact.firstName} ${lead.contact.lastName}
- Email: ${lead.contact.email}
- Phone: ${lead.contact.phone}
- ${propertyInfo}
- Status: ${lead.status}
- Priority: ${lead.priority}
${lead.inquiry?.message ? `- Message: ${lead.inquiry.message}` : ''}

View lead details: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Please contact this lead as soon as possible.

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  generateLeadAssignmentHTML(lead, agent, agency) {
    return this.generateLeadNotificationHTML(lead, agent, agency);
  }

  generateLeadAssignmentText(lead, agent, agency) {
    return this.generateLeadNotificationText(lead, agent, agency);
  }

  generateContactAgentRequestHTML(lead, agent, agency) {
    const propertyTitle = lead.property?.title || 'General Property Inquiry';
    const leadUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/agency/leads/${lead._id}`;
    const agencyName = agency?.name || 'SPIRELEAP';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f1f5f9; }
          .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
          .header { background: #ef4444; color: white; padding: 30px; text-align: center; }
          .badge { display: inline-block; padding: 4px 12px; background: #ffffff; color: #ef4444; border-radius: 20px; font-size: 12px; font-weight: 700; margin-bottom: 10px; text-transform: uppercase; }
          .content { padding: 40px 30px; }
          .lead-info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 25px; margin: 20px 0; }
          .info-row { display: flex; margin-bottom: 15px; border-bottom: 1px solid #f1f5f9; padding-bottom: 10px; }
          .info-label { width: 100px; font-weight: 600; color: #64748b; font-size: 14px; }
          .info-value { flex: 1; color: #1e293b; font-weight: 500; }
          .btn-container { text-align: center; margin-top: 30px; }
          .button { display: inline-block; background: #ef4444; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; }
          .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 13px; color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="badge">Immediate Contact Requested</div>
            <h1 style="margin: 0; font-size: 20px;">Direct Contact Request: ${lead.contact.firstName}</h1>
          </div>
          <div class="content">
            <p>Dear ${agent.firstName},</p>
            <p>A customer has just clicked "Contact Agent" on their dashboard for the following inquiry. They are waiting for your response.</p>
            
            <div class="lead-info-box">
              <div class="info-row">
                <div class="info-label">Customer</div>
                <div class="info-value">${lead.contact.firstName} ${lead.contact.lastName}</div>
              </div>
              <div class="info-row">
                <div class="info-label">Email</div>
                <div class="info-value">${lead.contact.email}</div>
              </div>
              <div class="info-row">
                <div class="info-label">Phone</div>
                <div class="info-value">${lead.contact.phone || 'Not provided'}</div>
              </div>
              <div class="info-row" style="border-bottom: none;">
                <div class="info-label">Property</div>
                <div class="info-value">${propertyTitle}</div>
              </div>
            </div>

            <div class="btn-container">
              <a href="${leadUrl}" class="button">View Lead Details</a>
            </div>

            <p style="margin-top: 30px; font-size: 14px; color: #64748b;">The customer is actively looking for information. Please contact them at your earliest convenience.</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${agencyName} Internal Notification</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateContactAgentRequestText(lead, agent, agency) {
    const propertyTitle = lead.property?.title || 'General Property Inquiry';
    const leadUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/agency/leads/${lead._id}`;
    const agencyName = agency?.name || 'SPIRELEAP';

    return `
Urgent: Customer Contact Request

Dear ${agent.firstName},

Customer ${lead.contact.firstName} ${lead.contact.lastName} has requested to be contacted regarding their inquiry for "${propertyTitle}".

Customer Details:
- Name: ${lead.contact.firstName} ${lead.contact.lastName}
- Email: ${lead.contact.email}
- Phone: ${lead.contact.phone || 'Not provided'}
- Property: ${propertyTitle}

View details and respond: ${leadUrl}

Best regards,
${agencyName} Team
    `;
  }

  async sendPropertyApprovalNotification(property, agent, agency) {
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for property approval notification');
        return null;
      }

      const mailOptions = {
        from: `"${agency?.name || this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: agent.email,
        subject: `Property Approved: ${property.title}`,
        html: this.generatePropertyApprovalHTML(property, agent, agency),
        text: this.generatePropertyApprovalText(property, agent, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Property approval email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending property approval email:', error);
      throw error;
    }
  }

  async sendPropertyRejectionNotification(property, agent, agency, reason) {
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for property rejection notification');
        return null;
      }

      const mailOptions = {
        from: `"${agency?.name || this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: agent.email,
        subject: `Property Rejected: ${property.title}`,
        html: this.generatePropertyRejectionHTML(property, agent, agency, reason),
        text: this.generatePropertyRejectionText(property, agent, agency, reason)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Property rejection email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending property rejection email:', error);
      throw error;
    }
  }

  generatePropertyApprovalHTML(property, agent, agency) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Property Approved</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #d4edda; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .property-details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Property Approved!</h1>
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>Great news! Your property listing has been approved and is now live.</p>
          </div>
          
          <div class="property-details">
            <h2>Property Details</h2>
            <p><strong>Title:</strong> ${property.title}</p>
            <p><strong>Location:</strong> ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}</p>
            <p><strong>Type:</strong> ${property.propertyType}</p>
            <p><strong>Listing Type:</strong> ${property.listingType}</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/properties/${property.slug || property._id}" class="button">View Property</a>
            </div>
            
            <p>Your property is now visible to potential buyers/renters on the website.</p>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generatePropertyApprovalText(property, agent, agency) {
    return `
Property Approved

Dear ${agent.firstName} ${agent.lastName},

Great news! Your property listing has been approved and is now live.

Property Details:
- Title: ${property.title}
- Location: ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}
- Type: ${property.propertyType}
- Listing Type: ${property.listingType}

View property: ${process.env.CLIENT_URL}/properties/${property.slug || property._id}

Your property is now visible to potential buyers/renters on the website.

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  generatePropertyRejectionHTML(property, agent, agency, reason) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Property Rejected</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #f8d7da; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .property-details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .reason-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ Property Rejected</h1>
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>Unfortunately, your property listing has been rejected.</p>
          </div>
          
          <div class="property-details">
            <h2>Property Details</h2>
            <p><strong>Title:</strong> ${property.title}</p>
            <p><strong>Location:</strong> ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}</p>
            
            ${reason ? `
            <div class="reason-box">
              <h3>Rejection Reason:</h3>
              <p>${reason}</p>
            </div>
            ` : ''}
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agent/properties/${property._id}" class="button">Edit Property</a>
            </div>
            
            <p>Please review the feedback above and make the necessary changes. You can resubmit the property for approval after making corrections.</p>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generatePropertyRejectionText(property, agent, agency, reason) {
    return `
Property Rejected

Dear ${agent.firstName} ${agent.lastName},

Unfortunately, your property listing has been rejected.

Property Details:
- Title: ${property.title}
- Location: ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}

${reason ? `Rejection Reason:\n${reason}\n` : ''}

Edit property: ${process.env.CLIENT_URL}/agent/properties/${property._id}

Please review the feedback above and make the necessary changes. You can resubmit the property for approval after making corrections.

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendFollowUpReminder(lead, agent, agency) {
    try {
      if (!agent || !agent.email) {
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject: `Follow-up Reminder: ${lead.contact.firstName} ${lead.contact.lastName}`,
        html: this.generateFollowUpReminderHTML(lead, agent, agency),
        text: this.generateFollowUpReminderText(lead, agent, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Follow-up reminder email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending follow-up reminder email:', error);
      throw error;
    }
  }

  async sendTaskReminder(lead, agent, agency, tasks) {
    try {
      if (!agent || !agent.email) {
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject: `Task Reminder: ${tasks.length} task(s) due for ${lead.contact.firstName} ${lead.contact.lastName}`,
        html: this.generateTaskReminderHTML(lead, agent, agency, tasks),
        text: this.generateTaskReminderText(lead, agent, agency, tasks)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Task reminder email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending task reminder email:', error);
      throw error;
    }
  }

  generateFollowUpReminderHTML(lead, agent, agency) {
    const followUpDate = lead.followUpDate ? new Date(lead.followUpDate).toLocaleDateString() : 'Today';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Follow-up Reminder</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #fff3cd; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .lead-details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⏰ Follow-up Reminder</h1>
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>You have a follow-up scheduled for <strong>${followUpDate}</strong>.</p>
          </div>
          
          <div class="lead-details">
            <h2>Lead Information</h2>
            <p><strong>Name:</strong> ${lead.contact.firstName} ${lead.contact.lastName}</p>
            <p><strong>Email:</strong> ${lead.contact.email}</p>
            <p><strong>Phone:</strong> ${lead.contact.phone}</p>
            <p><strong>Status:</strong> ${lead.status}</p>
            <p><strong>Follow-up Date:</strong> ${followUpDate}</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead Details</a>
            </div>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateFollowUpReminderText(lead, agent, agency) {
    const followUpDate = lead.followUpDate ? new Date(lead.followUpDate).toLocaleDateString() : 'Today';

    return `
Follow-up Reminder

Dear ${agent.firstName} ${agent.lastName},

You have a follow-up scheduled for ${followUpDate}.

Lead Information:
- Name: ${lead.contact.firstName} ${lead.contact.lastName}
- Email: ${lead.contact.email}
- Phone: ${lead.contact.phone}
- Status: ${lead.status}
- Follow-up Date: ${followUpDate}

View lead details: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  generateTaskReminderHTML(lead, agent, agency, tasks) {
    const tasksList = tasks.map(task => `
      <li>
        <strong>${task.title}</strong>
        ${task.description ? `<br>${task.description}` : ''}
        <br><small>Due: ${new Date(task.dueDate).toLocaleDateString()}</small>
      </li>
    `).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Task Reminder</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #fff3cd; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .lead-details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .tasks-list { list-style: none; padding: 0; }
          .tasks-list li { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #ffc107; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📋 Task Reminder</h1>
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>You have <strong>${tasks.length}</strong> task(s) due for the following lead.</p>
          </div>
          
          <div class="lead-details">
            <h2>Lead Information</h2>
            <p><strong>Name:</strong> ${lead.contact.firstName} ${lead.contact.lastName}</p>
            <p><strong>Email:</strong> ${lead.contact.email}</p>
            <p><strong>Phone:</strong> ${lead.contact.phone}</p>
            
            <h3>Due Tasks:</h3>
            <ul class="tasks-list">
              ${tasksList}
            </ul>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead & Tasks</a>
            </div>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateTaskReminderText(lead, agent, agency, tasks) {
    const tasksList = tasks.map(task =>
      `- ${task.title} (Due: ${new Date(task.dueDate).toLocaleDateString()})`
    ).join('\n');

    return `
Task Reminder

Dear ${agent.firstName} ${agent.lastName},

You have ${tasks.length} task(s) due for the following lead.

Lead Information:
- Name: ${lead.contact.firstName} ${lead.contact.lastName}
- Email: ${lead.contact.email}
- Phone: ${lead.contact.phone}

Due Tasks:
${tasksList}

View lead & tasks: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendSiteVisitConfirmation(lead, relationshipManager, agency, isUpdate = false) {
    try {
      if (!lead || !lead.contact.email) {
        return null;
      }

      const subject = isUpdate
        ? `Site Visit Rescheduled - ${agency?.name || 'SPIRELEAP'}`
        : `Site Visit Confirmation - ${agency?.name || 'SPIRELEAP'}`;

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: lead.contact.email,
        subject,
        html: this.generateSiteVisitConfirmationHTML(lead, relationshipManager, agency, isUpdate),
        text: this.generateSiteVisitConfirmationText(lead, relationshipManager, agency, isUpdate)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(isUpdate ? 'Site visit update confirmation email sent:' : 'Site visit confirmation email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit confirmation email:', error);
      throw error;
    }
  }

  generateSiteVisitConfirmationHTML(lead, relationshipManager, agency, isUpdate = false) {
    const visitDate = lead.siteVisit?.scheduledDate
      ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';
    const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
    const rmName = relationshipManager
      ? `${relationshipManager.firstName} ${relationshipManager.lastName}`
      : 'Our team';
    const rmPhone = relationshipManager?.phone || '';
    const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
    const visitProperty = lead.siteVisit?.property || lead.property;
    const propertyAgent = visitProperty?.agent;
    const agentName = propertyAgent ? `${propertyAgent.firstName || ''} ${propertyAgent.lastName || ''}`.trim() : '';
    const agentPhone = propertyAgent?.phone || '';
    const agentEmail = propertyAgent?.email || '';

    const headerTitle = isUpdate ? 'Site Visit Rescheduled' : 'Site Visit Confirmation';
    const introText = isUpdate
      ? 'Your site visit has been rescheduled. Please find the updated details below.'
      : 'Thank you for your interest! We are pleased to confirm your site visit appointment.';

    const agentContactBlock = (agentName || agentPhone || agentEmail)
      ? `
            <div class="details" style="margin-top: 15px;">
              <h3>Property Agent Contact:</h3>
              ${agentName ? `<p><strong>Name:</strong> ${agentName}</p>` : ''}
              ${agentPhone ? `<p><strong>Phone:</strong> <a href="tel:${agentPhone}">${agentPhone}</a></p>` : ''}
              ${agentEmail ? `<p><strong>Email:</strong> <a href="mailto:${agentEmail}">${agentEmail}</a></p>` : ''}
            </div>`
      : '';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .details { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #4F46E5; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${headerTitle}</h1>
          </div>
          <div class="content">
            <p>Dear ${lead.contact.firstName} ${lead.contact.lastName},</p>
            
            <p>${introText}</p>
            
            <div class="details">
              <h3>Visit Details:</h3>
              <p><strong>Date:</strong> ${visitDate}</p>
              <p><strong>Time:</strong> ${visitTime}</p>
              <p><strong>Property:</strong> ${propertyName}</p>
              <p><strong>Relationship Manager:</strong> ${rmName}</p>
              ${rmPhone ? `<p><strong>Contact:</strong> ${rmPhone}</p>` : ''}
            </div>
            ${agentContactBlock}
            
            <p>We look forward to meeting you and showing you the property. If you need to reschedule or have any questions, please contact the property agent or us at your earliest convenience.</p>
            
            <p>Best regards,<br>
            ${rmName}<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
          <div class="footer">
            <p>This is an automated confirmation email. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateSiteVisitConfirmationText(lead, relationshipManager, agency, isUpdate = false) {
    const visitDate = lead.siteVisit?.scheduledDate
      ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';
    const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
    const rmName = relationshipManager
      ? `${relationshipManager.firstName} ${relationshipManager.lastName}`
      : 'Our team';
    const rmPhone = relationshipManager?.phone || '';
    const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
    const visitProperty = lead.siteVisit?.property || lead.property;
    const propertyAgent = visitProperty?.agent;
    const agentName = propertyAgent ? `${propertyAgent.firstName || ''} ${propertyAgent.lastName || ''}`.trim() : '';
    const agentPhone = propertyAgent?.phone || '';
    const agentEmail = propertyAgent?.email || '';
    const headerTitle = isUpdate ? 'Site Visit Rescheduled' : 'Site Visit Confirmation';
    const introText = isUpdate
      ? 'Your site visit has been rescheduled. Please find the updated details below.'
      : 'Thank you for your interest! We are pleased to confirm your site visit appointment.';

    const agentSection = (agentName || agentPhone || agentEmail)
      ? `
Property Agent Contact:
${agentName ? `- Name: ${agentName}` : ''}
${agentPhone ? `- Phone: ${agentPhone}` : ''}
${agentEmail ? `- Email: ${agentEmail}` : ''}
`
      : '';

    return `
${headerTitle}

Dear ${lead.contact.firstName} ${lead.contact.lastName},

${introText}

Visit Details:
- Date: ${visitDate}
- Time: ${visitTime}
- Property: ${propertyName}
- Relationship Manager: ${rmName}
${rmPhone ? `- Contact: ${rmPhone}` : ''}
${agentSection}
We look forward to meeting you and showing you the property. If you need to reschedule or have any questions, please contact the property agent or us at your earliest convenience.

Best regards,
${rmName}
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendSiteVisitNotificationToAgent(lead, agent, agency, isUpdate = false) {
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for site visit notification');
        return null;
      }

      const subject = isUpdate
        ? `Site Visit Rescheduled - ${lead.contact.firstName} ${lead.contact.lastName}`
        : `Site Visit Scheduled - ${lead.contact.firstName} ${lead.contact.lastName}`;

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject,
        html: this.generateSiteVisitAgentNotificationHTML(lead, agent, agency, isUpdate),
        text: this.generateSiteVisitAgentNotificationText(lead, agent, agency, isUpdate)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(isUpdate ? 'Site visit update notification email sent to agent:' : 'Site visit notification email sent to agent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit notification email to agent:', error);
      throw error;
    }
  }

  generateSiteVisitAgentNotificationHTML(lead, agent, agency, isUpdate = false) {
    const visitDate = lead.siteVisit?.scheduledDate
      ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';
    const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
    const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
    const leadName = `${lead.contact.firstName} ${lead.contact.lastName}`;
    const leadPhone = lead.contact.phone || 'N/A';
    const leadEmail = lead.contact.email || 'N/A';
    const headerTitle = isUpdate ? 'Site Visit Rescheduled' : 'Site Visit Scheduled';
    const introText = isUpdate
      ? 'A site visit has been rescheduled for one of your assigned leads.'
      : 'A site visit has been scheduled for one of your assigned leads.';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .details { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #4F46E5; }
          .lead-info { background-color: #f0f9ff; padding: 15px; margin: 15px 0; border-radius: 5px; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${headerTitle}</h1>
          </div>
          <div class="content">
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            
            <p>${introText}</p>
            
            <div class="details">
              <h3>Visit Details:</h3>
              <p><strong>Date:</strong> ${visitDate}</p>
              <p><strong>Time:</strong> ${visitTime}</p>
              <p><strong>Property:</strong> ${propertyName}</p>
            </div>
            
            <div class="lead-info">
              <h3>Lead Information:</h3>
              <p><strong>Name:</strong> ${leadName}</p>
              <p><strong>Phone:</strong> ${leadPhone}</p>
              <p><strong>Email:</strong> ${leadEmail}</p>
              ${lead.inquiry?.message ? `<p><strong>Message:</strong> ${lead.inquiry.message}</p>` : ''}
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead Details</a>
            </div>
            
            <p>Please prepare for the site visit and ensure you have all necessary information ready.</p>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
          <div class="footer">
            <p>This is an automated notification. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateSiteVisitAgentNotificationText(lead, agent, agency, isUpdate = false) {
    const visitDate = lead.siteVisit?.scheduledDate
      ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';
    const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
    const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
    const leadName = `${lead.contact.firstName} ${lead.contact.lastName}`;
    const headerTitle = isUpdate ? 'Site Visit Rescheduled' : 'Site Visit Scheduled';
    const introText = isUpdate
      ? 'A site visit has been rescheduled for one of your assigned leads.'
      : 'A site visit has been scheduled for one of your assigned leads.';

    return `
${headerTitle}

Dear ${agent.firstName} ${agent.lastName},

${introText}

Visit Details:
- Date: ${visitDate}
- Time: ${visitTime}
- Property: ${propertyName}

Lead Information:
- Name: ${leadName}
- Phone: ${lead.contact.phone || 'N/A'}
- Email: ${lead.contact.email || 'N/A'}
${lead.inquiry?.message ? `- Message: ${lead.inquiry.message}` : ''}

View lead details: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Please prepare for the site visit and ensure you have all necessary information ready.

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  /** type: 'scheduled' | 'updated' | 'cancelled' | 'completed' - includes customer contact details */
  async sendSiteVisitNotificationToPropertyAgent(lead, propertyAgent, agency, type = 'scheduled') {
    try {
      if (!propertyAgent || !propertyAgent.email) return null;
      const customerName = `${lead.contact?.firstName || ''} ${lead.contact?.lastName || ''}`.trim() || 'Customer';
      const customerPhone = lead.contact?.phone || 'N/A';
      const customerEmail = lead.contact?.email || 'N/A';
      const visitDate = lead.siteVisit?.scheduledDate
        ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : 'TBD';
      const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
      const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';

      const subjects = {
        scheduled: `Site Visit Scheduled - ${customerName} (${propertyName})`,
        updated: `Site Visit Rescheduled - ${customerName} (${propertyName})`,
        cancelled: `Site Visit Cancelled - ${customerName} (${propertyName})`,
        completed: `Site Visit Completed - ${customerName} (${propertyName})`
      };
      const subject = subjects[type] || subjects.scheduled;

      const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#333}.container{max-width:600px;margin:0 auto;padding:20px}.header{background:#4F46E5;color:white;padding:20px;text-align:center}.content{padding:20px;background:#f9fafb}.details{background:white;padding:15px;margin:15px 0;border-left:4px solid #4F46E5}.customer{background:#f0f9ff;padding:15px;margin:15px 0;border-radius:5px}.footer{text-align:center;padding:20px;color:#666;font-size:12px}</style></head>
      <body>
      <div class="container">
        <div class="header"><h1>Site Visit ${type.charAt(0).toUpperCase() + type.slice(1)}</h1></div>
        <div class="content">
          <p>Dear ${propertyAgent.firstName} ${propertyAgent.lastName},</p>
          <p>A site visit for your property <strong>${propertyName}</strong> has been <strong>${type}</strong>.</p>
          <div class="details">
            <h3>Visit Details:</h3>
            <p><strong>Date:</strong> ${visitDate}</p>
            <p><strong>Time:</strong> ${visitTime}</p>
            <p><strong>Property:</strong> ${propertyName}</p>
          </div>
          <div class="customer">
            <h3>Customer Contact Details:</h3>
            <p><strong>Name:</strong> ${customerName}</p>
            <p><strong>Phone:</strong> <a href="tel:${customerPhone}">${customerPhone}</a></p>
            <p><strong>Email:</strong> <a href="mailto:${customerEmail}">${customerEmail}</a></p>
          </div>
          <p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p>
        </div>
        <div class="footer"><p>This is an automated notification.</p></div>
      </div>
      </body>
      </html>`;

      const text = `Site Visit ${type.charAt(0).toUpperCase() + type.slice(1)}\n\nDear ${propertyAgent.firstName} ${propertyAgent.lastName},\n\nA site visit for your property "${propertyName}" has been ${type}.\n\nVisit Details:\n- Date: ${visitDate}\n- Time: ${visitTime}\n- Property: ${propertyName}\n\nCustomer Contact Details:\n- Name: ${customerName}\n- Phone: ${customerPhone}\n- Email: ${customerEmail}\n\nBest regards,\n${agency?.name || 'SPIRELEAP'} Team`;

      const result = await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: propertyAgent.email,
        subject,
        html,
        text
      });
      console.log(`Site visit ${type} email sent to property agent:`, result.messageId);
      return result;
    } catch (error) {
      console.error(`Error sending site visit ${type} email to property agent:`, error);
      throw error;
    }
  }

  async sendSiteVisitCancellationToCustomer(lead, agency, propertyAgent = null) {
    try {
      if (!lead?.contact?.email) return null;
      const visitDate = lead.siteVisit?.scheduledDate ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
      const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
      const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
      const agent = propertyAgent || lead.siteVisit?.property?.agent || lead.property?.agent;
      const agentName = agent ? `${agent.firstName || ''} ${agent.lastName || ''}`.trim() : '';
      const agentPhone = agent?.phone || '';
      const agentEmail = agent?.email || '';
      const agentBlock = (agentName || agentPhone || agentEmail) ? `<div class="details" style="margin-top:15px"><h3>Property Agent Contact:</h3>${agentName ? `<p><strong>Name:</strong> ${agentName}</p>` : ''}${agentPhone ? `<p><strong>Phone:</strong> <a href="tel:${agentPhone}">${agentPhone}</a></p>` : ''}${agentEmail ? `<p><strong>Email:</strong> <a href="mailto:${agentEmail}">${agentEmail}</a></p>` : ''}</div>` : '';
      const agentSectionText = (agentName || agentPhone || agentEmail) ? `\n\nProperty Agent Contact:\n${agentName ? `- Name: ${agentName}\n` : ''}${agentPhone ? `- Phone: ${agentPhone}\n` : ''}${agentEmail ? `- Email: ${agentEmail}\n` : ''}` : '';
      const subject = `Site Visit Cancelled - ${agency?.name || 'SPIRELEAP'}`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#333}.container{max-width:600px;margin:0 auto;padding:20px}.header{background:#6B7280;color:white;padding:20px;text-align:center}.content{padding:20px;background:#f9fafb}.details{background:white;padding:15px;margin:15px 0;border-left:4px solid #6B7280}</style></head><body><div class="container"><div class="header"><h1>Site Visit Cancelled</h1></div><div class="content"><p>Dear ${lead.contact.firstName} ${lead.contact.lastName},</p><p>Your site visit appointment has been cancelled.</p><div class="details"><h3>Cancelled Visit:</h3><p><strong>Date:</strong> ${visitDate}</p><p><strong>Time:</strong> ${visitTime}</p><p><strong>Property:</strong> ${propertyName}</p></div>${agentBlock}<p>If you would like to reschedule, please contact the agent above or us.</p><p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p></div></div></body></html>`;
      const text = `Site Visit Cancelled\n\nDear ${lead.contact.firstName} ${lead.contact.lastName},\n\nYour site visit has been cancelled.\n\nCancelled Visit:\n- Date: ${visitDate}\n- Time: ${visitTime}\n- Property: ${propertyName}${agentSectionText}\nIf you would like to reschedule, please contact the agent above or us.\n\nBest regards,\n${agency?.name || 'SPIRELEAP'} Team`;
      const result = await this.transporter.sendMail({ from: `"${this.fromName}" <${this.fromEmail}>`, to: lead.contact.email, subject, html, text });
      console.log('Site visit cancellation email sent to customer:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit cancellation to customer:', error);
      throw error;
    }
  }

  async sendSiteVisitCompletedToCustomer(lead, agency, propertyAgent = null) {
    try {
      if (!lead?.contact?.email) return null;
      const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
      const agent = propertyAgent || lead.siteVisit?.property?.agent || lead.property?.agent;
      const agentName = agent ? `${agent.firstName || ''} ${agent.lastName || ''}`.trim() : '';
      const agentPhone = agent?.phone || '';
      const agentEmail = agent?.email || '';
      const agentBlock = (agentName || agentPhone || agentEmail) ? `<div class="details" style="margin-top:15px;border-left-color:#059669"><h3>Property Agent Contact:</h3>${agentName ? `<p><strong>Name:</strong> ${agentName}</p>` : ''}${agentPhone ? `<p><strong>Phone:</strong> <a href="tel:${agentPhone}">${agentPhone}</a></p>` : ''}${agentEmail ? `<p><strong>Email:</strong> <a href="mailto:${agentEmail}">${agentEmail}</a></p>` : ''}</div>` : '';
      const agentSectionText = (agentName || agentPhone || agentEmail) ? `\n\nProperty Agent Contact:\n${agentName ? `- Name: ${agentName}\n` : ''}${agentPhone ? `- Phone: ${agentPhone}\n` : ''}${agentEmail ? `- Email: ${agentEmail}\n` : ''}` : '';
      const subject = `Site Visit Completed - ${agency?.name || 'SPIRELEAP'}`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#333}.container{max-width:600px;margin:0 auto;padding:20px}.header{background:#059669;color:white;padding:20px;text-align:center}.content{padding:20px;background:#f9fafb}.details{background:white;padding:15px;margin:15px 0;border-left:4px solid #059669}</style></head><body><div class="container"><div class="header"><h1>Site Visit Completed</h1></div><div class="content"><p>Dear ${lead.contact.firstName} ${lead.contact.lastName},</p><p>Thank you for visiting <strong>${propertyName}</strong>. We hope you had a great experience.</p>${agentBlock}<p>If you have any questions or would like to take the next steps, please contact the agent above or us.</p><p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p></div></div></body></html>`;
      const text = `Site Visit Completed\n\nDear ${lead.contact.firstName} ${lead.contact.lastName},\n\nThank you for visiting ${propertyName}. We hope you had a great experience.${agentSectionText}\nIf you have any questions or would like to take the next steps, please contact the agent above or us.\n\nBest regards,\n${agency?.name || 'SPIRELEAP'} Team`;
      const result = await this.transporter.sendMail({ from: `"${this.fromName}" <${this.fromEmail}>`, to: lead.contact.email, subject, html, text });
      console.log('Site visit completed email sent to customer:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit completed to customer:', error);
      throw error;
    }
  }

  async sendSiteVisitCancellationToAgent(lead, agent, agency) {
    try {
      if (!agent?.email) return null;
      const visitDate = lead.siteVisit?.scheduledDate ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
      const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
      const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
      const customerName = `${lead.contact?.firstName || ''} ${lead.contact?.lastName || ''}`.trim() || 'Customer';
      const subject = `Site Visit Cancelled - ${customerName} (${propertyName})`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#333}.container{max-width:600px;margin:0 auto;padding:20px}.header{background:#6B7280;color:white;padding:20px;text-align:center}.content{padding:20px;background:#f9fafb}.details{background:white;padding:15px;margin:15px 0;border-left:4px solid #6B7280}.customer{background:#f0f9ff;padding:15px;margin:15px 0;border-radius:5px}</style></head><body><div class="container"><div class="header"><h1>Site Visit Cancelled</h1></div><div class="content"><p>Dear ${agent.firstName} ${agent.lastName},</p><p>A site visit has been cancelled.</p><div class="details"><h3>Cancelled Visit:</h3><p><strong>Date:</strong> ${visitDate}</p><p><strong>Time:</strong> ${visitTime}</p><p><strong>Property:</strong> ${propertyName}</p></div><div class="customer"><h3>Customer Contact:</h3><p><strong>Name:</strong> ${customerName}</p><p><strong>Phone:</strong> ${lead.contact?.phone || 'N/A'}</p><p><strong>Email:</strong> ${lead.contact?.email || 'N/A'}</p></div><p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p></div></div></body></html>`;
      const text = `Site Visit Cancelled\n\nDear ${agent.firstName} ${agent.lastName},\n\nA site visit has been cancelled.\n\nVisit: ${visitDate} at ${visitTime}, ${propertyName}\nCustomer: ${customerName}, ${lead.contact?.phone || 'N/A'}, ${lead.contact?.email || 'N/A'}\n\nBest regards,\n${agency?.name || 'SPIRELEAP'} Team`;
      const result = await this.transporter.sendMail({ from: `"${this.fromName}" <${this.fromEmail}>`, to: agent.email, subject, html, text });
      console.log('Site visit cancellation email sent to agent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit cancellation to agent:', error);
      throw error;
    }
  }

  async sendSiteVisitCompletedToAgent(lead, agent, agency) {
    try {
      if (!agent?.email) return null;
      const propertyName = lead.siteVisit?.property?.title || lead.property?.title || 'Property';
      const customerName = `${lead.contact?.firstName || ''} ${lead.contact?.lastName || ''}`.trim() || 'Customer';
      const subject = `Site Visit Completed - ${customerName} (${propertyName})`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#333}.container{max-width:600px;margin:0 auto;padding:20px}.header{background:#059669;color:white;padding:20px;text-align:center}.content{padding:20px;background:#f9fafb}.details{background:white;padding:15px;margin:15px 0;border-left:4px solid #059669}.customer{background:#f0fdf4;padding:15px;margin:15px 0;border-radius:5px}</style></head><body><div class="container"><div class="header"><h1>Site Visit Completed</h1></div><div class="content"><p>Dear ${agent.firstName} ${agent.lastName},</p><p>A site visit has been marked as completed.</p><div class="details"><h3>Visit:</h3><p><strong>Property:</strong> ${propertyName}</p></div><div class="customer"><h3>Customer Contact:</h3><p><strong>Name:</strong> ${customerName}</p><p><strong>Phone:</strong> ${lead.contact?.phone || 'N/A'}</p><p><strong>Email:</strong> ${lead.contact?.email || 'N/A'}</p></div><p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p></div></div></body></html>`;
      const text = `Site Visit Completed\n\nDear ${agent.firstName} ${agent.lastName},\n\nA site visit has been marked as completed.\n\nProperty: ${propertyName}\nCustomer: ${customerName}, ${lead.contact?.phone || 'N/A'}, ${lead.contact?.email || 'N/A'}\n\nBest regards,\n${agency?.name || 'SPIRELEAP'} Team`;
      const result = await this.transporter.sendMail({ from: `"${this.fromName}" <${this.fromEmail}>`, to: agent.email, subject, html, text });
      console.log('Site visit completed email sent to agent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit completed to agent:', error);
      throw error;
    }
  }

  async sendSiteVisitReminder(lead, relationshipManager, agency) {
    try {
      if (!relationshipManager || !relationshipManager.email) {
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: relationshipManager.email,
        subject: `Site Visit Reminder - ${lead.contact.firstName} ${lead.contact.lastName}`,
        html: this.generateSiteVisitReminderHTML(lead, relationshipManager, agency),
        text: this.generateSiteVisitReminderText(lead, relationshipManager, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Site visit reminder email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit reminder email:', error);
      throw error;
    }
  }

  generateSiteVisitReminderHTML(lead, relationshipManager, agency) {
    const visitDate = lead.siteVisit?.scheduledDate
      ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';
    const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
    const propertyName = lead.property?.title || 'Property';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #F59E0B; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .details { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #F59E0B; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Site Visit Reminder</h1>
          </div>
          <div class="content">
            <p>Dear ${relationshipManager.firstName} ${relationshipManager.lastName},</p>
            
            <p>This is a reminder about your upcoming site visit appointment.</p>
            
            <div class="details">
              <h3>Visit Details:</h3>
              <p><strong>Date:</strong> ${visitDate}</p>
              <p><strong>Time:</strong> ${visitTime}</p>
              <p><strong>Lead:</strong> ${lead.contact.firstName} ${lead.contact.lastName}</p>
              <p><strong>Contact:</strong> ${lead.contact.phone} | ${lead.contact.email}</p>
              <p><strong>Property:</strong> ${propertyName}</p>
            </div>
            
            <p>Please ensure you are prepared for the visit and have all necessary materials ready.</p>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
          <div class="footer">
            <p>This is an automated reminder email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateSiteVisitReminderText(lead, relationshipManager, agency) {
    const visitDate = lead.siteVisit?.scheduledDate
      ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';
    const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
    const propertyName = lead.property?.title || 'Property';

    return `
Site Visit Reminder

Dear ${relationshipManager.firstName} ${relationshipManager.lastName},

This is a reminder about your upcoming site visit appointment.

Visit Details:
- Date: ${visitDate}
- Time: ${visitTime}
- Lead: ${lead.contact.firstName} ${lead.contact.lastName}
- Contact: ${lead.contact.phone} | ${lead.contact.email}
- Property: ${propertyName}

Please ensure you are prepared for the visit and have all necessary materials ready.

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendFollowUpReminder(lead, agent, agency) {
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for follow-up reminder');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject: `Follow-Up Reminder - ${lead.contact.firstName} ${lead.contact.lastName}`,
        html: this.generateFollowUpReminderHTML(lead, agent, agency),
        text: this.generateFollowUpReminderText(lead, agent, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Follow-up reminder email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending follow-up reminder email:', error);
      throw error;
    }
  }

  generateFollowUpReminderHTML(lead, agent, agency) {
    const followUpDate = lead.followUpDate
      ? new Date(lead.followUpDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #F59E0B; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .details { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #F59E0B; }
          .button { display: inline-block; background: #F59E0B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Follow-Up Reminder</h1>
          </div>
          <div class="content">
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>This is a reminder to follow up with a lead assigned to you.</p>
            <div class="details">
              <h3>Lead Information:</h3>
              <p><strong>Lead ID:</strong> ${lead.leadId}</p>
              <p><strong>Name:</strong> ${lead.contact.firstName} ${lead.contact.lastName}</p>
              <p><strong>Phone:</strong> ${lead.contact.phone}</p>
              <p><strong>Email:</strong> ${lead.contact.email}</p>
              <p><strong>Follow-Up Date:</strong> ${followUpDate}</p>
              <p><strong>Status:</strong> ${lead.status}</p>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead Details</a>
            </div>
            <p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateFollowUpReminderText(lead, agent, agency) {
    const followUpDate = lead.followUpDate
      ? new Date(lead.followUpDate).toLocaleDateString()
      : 'TBD';

    return `
Follow-Up Reminder

Dear ${agent.firstName} ${agent.lastName},

This is a reminder to follow up with a lead assigned to you.

Lead Information:
- Lead ID: ${lead.leadId}
- Name: ${lead.contact.firstName} ${lead.contact.lastName}
- Phone: ${lead.contact.phone}
- Email: ${lead.contact.email}
- Follow-Up Date: ${followUpDate}
- Status: ${lead.status}

View lead details: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendTaskReminder(lead, agent, agency, tasks) {
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for task reminder');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject: `Task Reminder - ${tasks.length} task(s) due`,
        html: this.generateTaskReminderHTML(lead, agent, agency, tasks),
        text: this.generateTaskReminderText(lead, agent, agency, tasks)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Task reminder email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending task reminder email:', error);
      throw error;
    }
  }

  generateTaskReminderHTML(lead, agent, agency, tasks) {
    const tasksList = tasks.map(task => `
      <li>
        <strong>${task.title}</strong><br>
        Due: ${new Date(task.dueDate).toLocaleDateString()}<br>
        Status: ${task.status}
      </li>
    `).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #8B5CF6; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .button { display: inline-block; background: #8B5CF6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Task Reminder</h1>
          </div>
          <div class="content">
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>You have ${tasks.length} task(s) due for lead ${lead.leadId}: ${lead.contact.firstName} ${lead.contact.lastName}</p>
            <ul>${tasksList}</ul>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead Details</a>
            </div>
            <p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateTaskReminderText(lead, agent, agency, tasks) {
    const tasksList = tasks.map(task =>
      `- ${task.title} (Due: ${new Date(task.dueDate).toLocaleDateString()}, Status: ${task.status})`
    ).join('\n');

    return `
Task Reminder

Dear ${agent.firstName} ${agent.lastName},

You have ${tasks.length} task(s) due for lead ${lead.leadId}: ${lead.contact.firstName} ${lead.contact.lastName}

Tasks:
${tasksList}

View lead details: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendSiteVisitReminder(lead, relationshipManager, agency) {
    try {
      if (!relationshipManager || !relationshipManager.email) {
        console.log('Relationship manager email not available for site visit reminder');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: relationshipManager.email,
        subject: `Site Visit Reminder - ${lead.contact.firstName} ${lead.contact.lastName}`,
        html: this.generateSiteVisitReminderHTML(lead, relationshipManager, agency),
        text: this.generateSiteVisitReminderText(lead, relationshipManager, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Site visit reminder email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending site visit reminder email:', error);
      throw error;
    }
  }

  generateSiteVisitReminderHTML(lead, relationshipManager, agency) {
    const visitDate = lead.siteVisit?.scheduledDate
      ? new Date(lead.siteVisit.scheduledDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';
    const visitTime = lead.siteVisit?.scheduledTime || 'TBD';
    const propertyName = lead.property?.title || 'Property';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #10B981; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .details { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #10B981; }
          .button { display: inline-block; background: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Site Visit Reminder</h1>
          </div>
          <div class="content">
            <p>Dear ${relationshipManager.firstName} ${relationshipManager.lastName},</p>
            <p>This is a reminder about your upcoming site visit appointment.</p>
            <div class="details">
              <h3>Visit Details:</h3>
              <p><strong>Date:</strong> ${visitDate}</p>
              <p><strong>Time:</strong> ${visitTime}</p>
              <p><strong>Lead:</strong> ${lead.contact.firstName} ${lead.contact.lastName}</p>
              <p><strong>Contact:</strong> ${lead.contact.phone} | ${lead.contact.email}</p>
              <p><strong>Property:</strong> ${propertyName}</p>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead Details</a>
            </div>
            <p>Please ensure you are prepared for the visit and have all necessary materials ready.</p>
            <p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  async sendMissedFollowUpAlert(lead, agent, agency, daysOverdue) {
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for missed follow-up alert');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject: `⚠️ MISSED FOLLOW-UP ALERT - ${daysOverdue} day(s) overdue - ${lead.leadId}`,
        html: this.generateMissedFollowUpAlertHTML(lead, agent, agency, daysOverdue),
        text: this.generateMissedFollowUpAlertText(lead, agent, agency, daysOverdue)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Missed follow-up alert email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending missed follow-up alert email:', error);
      throw error;
    }
  }

  generateMissedFollowUpAlertHTML(lead, agent, agency, daysOverdue) {
    const followUpDate = lead.followUpDate
      ? new Date(lead.followUpDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #EF4444; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .alert { background-color: #FEE2E2; border-left: 4px solid #EF4444; padding: 15px; margin: 15px 0; }
          .details { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #EF4444; }
          .button { display: inline-block; background: #EF4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ MISSED FOLLOW-UP ALERT</h1>
          </div>
          <div class="content">
            <div class="alert">
              <h2 style="margin-top: 0; color: #EF4444;">This follow-up is ${daysOverdue} day(s) overdue!</h2>
              <p><strong>Action Required:</strong> Please follow up with this lead immediately.</p>
            </div>
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>You have a missed follow-up that requires immediate attention.</p>
            <div class="details">
              <h3>Lead Information:</h3>
              <p><strong>Lead ID:</strong> ${lead.leadId}</p>
              <p><strong>Name:</strong> ${lead.contact.firstName} ${lead.contact.lastName}</p>
              <p><strong>Phone:</strong> ${lead.contact.phone}</p>
              <p><strong>Email:</strong> ${lead.contact.email}</p>
              <p><strong>Follow-Up Date:</strong> ${followUpDate}</p>
              <p><strong>Days Overdue:</strong> ${daysOverdue} day(s)</p>
              <p><strong>Status:</strong> ${lead.status}</p>
              <p><strong>Priority:</strong> ${lead.priority}</p>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead & Follow Up Now</a>
            </div>
            <p><strong>Please contact this lead as soon as possible to avoid further delays.</strong></p>
            <p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateMissedFollowUpAlertText(lead, agent, agency, daysOverdue) {
    const followUpDate = lead.followUpDate
      ? new Date(lead.followUpDate).toLocaleDateString()
      : 'TBD';

    return `
⚠️ MISSED FOLLOW-UP ALERT

Dear ${agent.firstName} ${agent.lastName},

This follow-up is ${daysOverdue} day(s) overdue! Action Required: Please follow up with this lead immediately.

Lead Information:
- Lead ID: ${lead.leadId}
- Name: ${lead.contact.firstName} ${lead.contact.lastName}
- Phone: ${lead.contact.phone}
- Email: ${lead.contact.email}
- Follow-Up Date: ${followUpDate}
- Days Overdue: ${daysOverdue} day(s)
- Status: ${lead.status}
- Priority: ${lead.priority}

View lead details: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Please contact this lead as soon as possible to avoid further delays.

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendMissedFollowUpAlertToManager(lead, agent, manager, agency, daysOverdue) {
    try {
      if (!manager || !manager.email) {
        console.log('Manager email not available for missed follow-up alert');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: manager.email,
        subject: `⚠️ Team Member Missed Follow-Up - ${lead.leadId} (${daysOverdue} days overdue)`,
        html: this.generateMissedFollowUpManagerAlertHTML(lead, agent, manager, agency, daysOverdue),
        text: this.generateMissedFollowUpManagerAlertText(lead, agent, manager, agency, daysOverdue)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Missed follow-up alert email sent to manager:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending missed follow-up alert email to manager:', error);
      throw error;
    }
  }

  generateMissedFollowUpManagerAlertHTML(lead, agent, manager, agency, daysOverdue) {
    const followUpDate = lead.followUpDate
      ? new Date(lead.followUpDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'TBD';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #F59E0B; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .alert { background-color: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 15px 0; }
          .details { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #F59E0B; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Team Member Missed Follow-Up</h1>
          </div>
          <div class="content">
            <div class="alert">
              <p><strong>Alert:</strong> One of your team members has a missed follow-up that is ${daysOverdue} day(s) overdue.</p>
            </div>
            <p>Dear ${manager.firstName} ${manager.lastName},</p>
            <div class="details">
              <h3>Lead Information:</h3>
              <p><strong>Lead ID:</strong> ${lead.leadId}</p>
              <p><strong>Name:</strong> ${lead.contact.firstName} ${lead.contact.lastName}</p>
              <p><strong>Phone:</strong> ${lead.contact.phone}</p>
              <p><strong>Email:</strong> ${lead.contact.email}</p>
              <p><strong>Follow-Up Date:</strong> ${followUpDate}</p>
              <p><strong>Days Overdue:</strong> ${daysOverdue} day(s)</p>
              <h3>Assigned Agent:</h3>
              <p><strong>Name:</strong> ${agent.firstName} ${agent.lastName}</p>
              <p><strong>Email:</strong> ${agent.email}</p>
            </div>
            <p>Please ensure your team member follows up with this lead immediately.</p>
            <p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateMissedFollowUpManagerAlertText(lead, agent, manager, agency, daysOverdue) {
    const followUpDate = lead.followUpDate
      ? new Date(lead.followUpDate).toLocaleDateString()
      : 'TBD';

    return `
Team Member Missed Follow-Up

Dear ${manager.firstName} ${manager.lastName},

Alert: One of your team members has a missed follow-up that is ${daysOverdue} day(s) overdue.

Lead Information:
- Lead ID: ${lead.leadId}
- Name: ${lead.contact.firstName} ${lead.contact.lastName}
- Phone: ${lead.contact.phone}
- Email: ${lead.contact.email}
- Follow-Up Date: ${followUpDate}
- Days Overdue: ${daysOverdue} day(s)

Assigned Agent:
- Name: ${agent.firstName} ${agent.lastName}
- Email: ${agent.email}

Please ensure your team member follows up with this lead immediately.

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendMissedTaskAlert(lead, agent, agency, tasks, daysOverdue) {
    try {
      if (!agent || !agent.email) {
        console.log('Agent email not available for missed task alert');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject: `⚠️ MISSED TASK ALERT - ${tasks.length} task(s) overdue - ${lead.leadId}`,
        html: this.generateMissedTaskAlertHTML(lead, agent, agency, tasks, daysOverdue),
        text: this.generateMissedTaskAlertText(lead, agent, agency, tasks, daysOverdue)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Missed task alert email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending missed task alert email:', error);
      throw error;
    }
  }

  generateMissedTaskAlertHTML(lead, agent, agency, tasks, daysOverdue) {
    const tasksList = tasks.map(task => {
      const taskDaysOverdue = Math.floor((new Date() - new Date(task.dueDate)) / (1000 * 60 * 60 * 24));
      return `
        <li>
          <strong>${task.title}</strong><br>
          Due: ${new Date(task.dueDate).toLocaleDateString()}<br>
          Overdue: ${taskDaysOverdue} day(s)<br>
          Status: ${task.status}
        </li>
      `;
    }).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #EF4444; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .alert { background-color: #FEE2E2; border-left: 4px solid #EF4444; padding: 15px; margin: 15px 0; }
          .button { display: inline-block; background: #EF4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ MISSED TASK ALERT</h1>
          </div>
          <div class="content">
            <div class="alert">
              <h2 style="margin-top: 0; color: #EF4444;">You have ${tasks.length} overdue task(s)!</h2>
            </div>
            <p>Dear ${agent.firstName} ${agent.lastName},</p>
            <p>You have missed tasks for lead ${lead.leadId}: ${lead.contact.firstName} ${lead.contact.lastName}</p>
            <ul>${tasksList}</ul>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/leads/${lead._id}" class="button">View Lead & Complete Tasks</a>
            </div>
            <p>Best regards,<br>${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateMissedTaskAlertText(lead, agent, agency, tasks, daysOverdue) {
    const tasksList = tasks.map(task => {
      const taskDaysOverdue = Math.floor((new Date() - new Date(task.dueDate)) / (1000 * 60 * 60 * 24));
      return `- ${task.title} (Due: ${new Date(task.dueDate).toLocaleDateString()}, Overdue: ${taskDaysOverdue} day(s), Status: ${task.status})`;
    }).join('\n');

    return `
⚠️ MISSED TASK ALERT

Dear ${agent.firstName} ${agent.lastName},

You have ${tasks.length} overdue task(s) for lead ${lead.leadId}: ${lead.contact.firstName} ${lead.contact.lastName}

Tasks:
${tasksList}

View lead details: ${process.env.CLIENT_URL}/agency/leads/${lead._id}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendBulkLeadNotification(lead, agency, recipients) {
    await this.ensureInitialized();
    try {
      if (!recipients || recipients.length === 0) {
        console.log('No recipients available for lead notification');
        return null;
      }

      const propertyTitle = lead.property?.title || 'General Inquiry';
      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients.join(','),
        subject: `Property Inquiry: ${propertyTitle} - ${lead.contact.firstName} ${lead.contact.lastName}`,
        html: this.generateLeadNotificationHTML(lead, { firstName: 'Admin', lastName: '' }, agency),
        text: this.generateLeadNotificationText(lead, { firstName: 'Admin', lastName: '' }, agency)
      };

      console.log(`EmailService: Attempting to send bulk notification from: ${this.fromEmail} to: ${recipients.length} recipients`);
      const result = await this.transporter.sendMail(mailOptions);
      console.log('Bulk lead notification email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending bulk lead notification email:', error);
      throw error;
    }
  }

  async sendContactMessageNotification(message, agency, recipients) {
    await this.ensureInitialized();
    try {
      if (!recipients || recipients.length === 0) {
        console.log('No recipients available for contact message notification');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients.join(','),
        subject: `New Contact Enquiry: ${message.name}`,
        html: this.generateContactMessageNotificationHTML(message, agency),
        text: this.generateContactMessageNotificationText(message, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Contact message notification email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending contact message notification email:', error);
      throw error;
    }
  }

  generateContactMessageNotificationHTML(message, agency) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>New Contact Enquiry</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #2c5aa0; }
          .details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .message-box { background: #f4f4f4; padding: 15px; border-radius: 5px; margin: 15px 0; font-style: italic; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">New Contact Enquiry</h1>
            <p>A new visitor has submitted a contact form on your website.</p>
          </div>
          <div class="details">
            <h2 style="color: #2c5aa0; border-bottom: 1px solid #eee; padding-bottom: 10px;">Visitor Details</h2>
            <p><strong>Name:</strong> ${message.name}</p>
            <p><strong>Email:</strong> ${message.email}</p>
            <p><strong>Phone:</strong> ${message.phone || 'N/A'}</p>
            <p><strong>Subject:</strong> ${message.subject || 'N/A'}</p>
            <p><strong>Message:</strong></p>
            <div class="message-box">
              ${message.message}
            </div>
            <p><strong>Agency:</strong> ${agency?.name || 'N/A'}</p>
          </div>
          <p style="text-align: center; color: #666; font-size: 12px; margin-top: 30px;">
            Best regards,<br>
            <strong>${agency?.name || 'SPIRELEAP'} Team</strong>
          </p>
        </div>
      </body>
      </html>
    `;
  }

  generateContactMessageNotificationText(message, agency) {
    return `
New Contact Enquiry

A new visitor has submitted a contact form on your website.

Visitor Details:
- Name: ${message.name}
- Email: ${message.email}
- Phone: ${message.phone || 'N/A'}
- Subject: ${message.subject || 'N/A'}
- Message: ${message.message}
- Agency: ${agency?.name || 'N/A'}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendNewPropertyNotificationToAgent(property, agent, agency) {
    await this.ensureInitialized();
    try {
      if (!agent || !agent.email) {
        console.log('No agent email available for new property notification');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: agent.email,
        subject: `New Property Assigned: ${property.title}`,
        html: this.generateNewPropertyAssignedHTML(property, agent, agency),
        text: this.generateNewPropertyAssignedText(property, agent, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('New property assigned notification sent to agent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending new property assigned notification:', error);
      throw error;
    }
  }

  generateNewPropertyAssignedHTML(property, agent, agency) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>New Property Assigned</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #eef2f7; padding: 20px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #2c5aa0; }
          .property-details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">New Property Assigned</h1>
            <p>You have been assigned to a new property listing.</p>
          </div>
          
          <div class="property-details">
            <h2>Listing Information</h2>
            <p><strong>Title:</strong> ${property.title}</p>
            <p><strong>Property Type:</strong> ${property.propertyType}</p>
            <p><strong>Listing Type:</strong> ${property.listingType}</p>
            <p><strong>Location:</strong> ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}</p>
            

            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateNewPropertyAssignedText(property, agent, agency) {
    return `
New Property Assigned

You have been assigned to a new property listing.

Listing Information:
- Title: ${property.title}
- Property Type: ${property.propertyType}
- Listing Type: ${property.listingType}
- Location: ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}



Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendNewPropertyNotificationToAdmin(property, agent, agency, recipients) {
    await this.ensureInitialized();
    try {
      if (!recipients || recipients.length === 0) {
        console.log('No recipients available for new property notification');
        return null;
      }

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients.join(','),
        subject: `New Property Listing Added: ${property.title}`,
        html: this.generateNewPropertyListingHTML(property, agent, agency),
        text: this.generateNewPropertyListingText(property, agent, agency)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('New property listing notification sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending new property listing notification:', error);
      throw error;
    }
  }

  generateNewPropertyListingHTML(property, agent, agency) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>New Property Listing Added</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #eef2f7; padding: 20px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #2c5aa0; }
          .property-details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .button { display: inline-block; background: #2c5aa0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">New Property Listing</h1>
            <p>An agent has added a new property listing that requires your review.</p>
          </div>
          
          <div class="property-details">
            <h2>Listing Information</h2>
            <p><strong>Title:</strong> ${property.title}</p>
            <p><strong>Agent:</strong> ${agent.firstName || ''} ${agent.lastName || ''}</p>
            <p><strong>Property Type:</strong> ${property.propertyType}</p>
            <p><strong>Listing Type:</strong> ${property.listingType}</p>
            <p><strong>Location:</strong> ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.CLIENT_URL}/agency/properties/${property._id}" class="button">Review Property</a>
            </div>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateNewPropertyListingText(property, agent, agency) {
    return `
New Property Listing Added

An agent has added a new property listing that requires your review.

Listing Information:
- Title: ${property.title}
- Agent: ${agent.firstName || ''} ${agent.lastName || ''}
- Property Type: ${property.propertyType}
- Listing Type: ${property.listingType}
- Location: ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}

Review Property: ${process.env.CLIENT_URL}/agency/properties/${property._id}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendPropertyStatusUpdateNotification(property, agent, agency, recipients, newStatus) {
    await this.ensureInitialized();
    try {
      if (!recipients || recipients.length === 0) {
        return null;
      }

      const statusLabels = {
        'sold': 'SOLD',
        'rented': 'RENTED',
        'unavailable': 'UNAVAILABLE',
        'inactive': 'UNAVAILABLE'
      };

      const label = statusLabels[newStatus] || newStatus.toUpperCase();

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients.join(','),
        subject: `Property Status Updated to ${label}: ${property.title}`,
        html: this.generatePropertyStatusUpdateHTML(property, agent, agency, label),
        text: this.generatePropertyStatusUpdateText(property, agent, agency, label)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`Property status update notification (${label}) sent:`, result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending property status update notification:', error);
      throw error;
    }
  }

  generatePropertyStatusUpdateHTML(property, agent, agency, statusLabel) {
    const color = statusLabel === 'SOLD' ? '#d32f2f' : statusLabel === 'RENTED' ? '#2e7d32' : '#757575';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Property Status Updated: ${statusLabel}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #f4f6f8; padding: 20px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid ${color}; }
          .property-details { background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
          .badge { display: inline-block; background: ${color}; color: white; padding: 5px 12px; border-radius: 4px; font-weight: bold; text-transform: uppercase; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Property Status Update</h1>
            <p>The status of a property has been updated to <span class="badge">${statusLabel}</span>.</p>
          </div>
          
          <div class="property-details">
            <h2>Listing Information</h2>
            <p><strong>Title:</strong> ${property.title}</p>
            <p><strong>New Status:</strong> <span style="color: ${color}; font-weight: bold;">${statusLabel}</span></p>
            <p><strong>Agent:</strong> ${agent?.firstName || ''} ${agent?.lastName || ''}</p>
            <p><strong>Location:</strong> ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}</p>
            
            <p>This listing has been updated in the CRM.</p>
            
            <p>Best regards,<br>
            ${agency?.name || 'SPIRELEAP'} Team</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generatePropertyStatusUpdateText(property, agent, agency, statusLabel) {
    return `
Property Status Update

The status of the following property has been updated to ${statusLabel}.

Listing Information:
- Title: ${property.title}
- New Status: ${statusLabel}
- Agent: ${agent?.firstName || ''} ${agent?.lastName || ''}
- Location: ${property.location?.address || 'N/A'}, ${property.location?.city || 'N/A'}

Best regards,
${agency?.name || 'SPIRELEAP'} Team
    `;
  }

  async sendPasswordChangeConfirmation(user) {
    await this.ensureInitialized();
    try {
      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: user.email,
        subject: 'Security Alert: Your Password Was Changed',
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-top: 4px solid #d32f2f; border-radius: 5px;">
            <h2 style="color: #d32f2f;">Security Alert</h2>
            <p>Dear ${user.firstName},</p>
            <p>This is a confirmation that the password for your SPIRELEAP CRM account was recently changed.</p>
            <p>If you made this change, you can safely ignore this email.</p>
            <p><strong>If you did NOT change your password</strong>, please contact your administrator immediately or use the "Forgot Password" link on the login page to secure your account.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="font-size: 12px; color: #666;">This is an automated security notification. Please do not reply to this email.</p>
          </div>
        `,
        text: `Security Alert: Your password was recently changed. If you did not make this change, please contact your administrator immediately.`
      };

      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      console.error('Error sending password change confirmation:', error);
    }
  }

  async sendProfileUpdateNotification(user) {
    await this.ensureInitialized();
    try {
      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: user.email,
        subject: 'Profile Information Updated',
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-top: 4px solid #2c5aa0; border-radius: 5px;">
            <h2 style="color: #2c5aa0;">Profile Updated</h2>
            <p>Dear ${user.firstName},</p>
            <p>Your profile information on SPIRELEAP CRM has been successfully updated.</p>
            <p>If you did not perform this action, please review your account settings or contact an administrator.</p>
            <p>Best regards,<br>SPIRELEAP team</p>
          </div>
        `,
        text: `Your profile information on SPIRELEAP CRM has been updated.`
      };

      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      console.error('Error sending profile update notification:', error);
    }
  }

  async sendRoleChangeNotification(user, oldRole, newRole) {
    await this.ensureInitialized();
    try {
      const formatRole = (role) => role.replace('_', ' ').toUpperCase();
      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: user.email,
        subject: 'Account Role Updated',
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-top: 4px solid #f39c12; border-radius: 5px;">
            <h2 style="color: #f39c12;">Role Updated</h2>
            <p>Dear ${user.firstName},</p>
            <p>Your account role in the SPIRELEAP CRM has been updated by an administrator.</p>
            <div style="background: #fdf2e9; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Previous Role:</strong> ${formatRole(oldRole)}</p>
              <p style="margin: 5px 0 0 0;"><strong>New Role:</strong> ${formatRole(newRole)}</p>
            </div>
            <p>Your permissions in the system have been adjusted accordingly. Please log out and log back in to see the changes.</p>
            <p>Best regards,<br>SPIRELEAP team</p>
          </div>
        `,
        text: `Your account role has been updated from ${oldRole} to ${newRole}. Please log out and log back in.`
      };

      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      console.error('Error sending role change notification:', error);
    }
  }

  async sendPaymentSuccessEmail(payment, lead, property) {
    await this.ensureInitialized();
    try {
      if (!lead || !lead.contact || !lead.contact.email) {
        console.log('Customer email not available for payment success notification');
        return null;
      }

      const variables = {
        customerName: `${lead.contact.firstName} ${lead.contact.lastName}`,
        amount: payment.amount,
        currency: payment.currency,
        receiptNumber: payment.receipt?.number || 'N/A',
        propertyTitle: property?.title || 'Property Booking',
        paymentDate: new Date(payment.paymentDate || new Date()).toLocaleDateString(),
        paymentMethod: payment.paymentMethod || payment.gateway
      };

      const { html, text, subject } = await this.getTemplate('payment-success', variables, () => ({
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 0; border: 1px solid #e1e1e1; border-radius: 8px; overflow: hidden;">
            <div style="background: #2c5aa0; color: white; padding: 30px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px;">Payment Successful!</h1>
            </div>
            <div style="padding: 30px; background: #ffffff;">
              <p>Dear ${variables.customerName},</p>
              <p>Thank you for your payment. We are pleased to confirm that your payment for <strong>${variables.propertyTitle}</strong> has been successfully processed.</p>
              
              <div style="background: #f9f9f9; padding: 20px; border-radius: 6px; margin: 25px 0;">
                <h3 style="margin-top: 0; color: #2c5aa0; border-bottom: 1px solid #eee; padding-bottom: 10px;">Payment Details</h3>
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Receipt Number:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.receiptNumber}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Amount Paid:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.currency} ${variables.amount}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Date:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.paymentDate}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Payment Method:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.paymentMethod.toUpperCase()}</td>
                  </tr>
                </table>
              </div>
              
              <p>You can find your official receipt attached to this email or view it in your dashboard.</p>
              
              <p>Our team will contact you shortly regarding the next steps for your booking.</p>
              
              <div style="text-align: center; margin-top: 30px;">
                <p>Best regards,<br><strong>SPIRELEAP Real Estate Team</strong></p>
              </div>
            </div>
            <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 12px; color: #777;">
              <p>&copy; ${new Date().getFullYear()} SPIRELEAP Real Estate CRM. All rights reserved.</p>
            </div>
          </div>
        `,
        text: `
Payment Successful!

Dear ${variables.customerName},

Thank you for your payment. We are pleased to confirm that your payment for ${variables.propertyTitle} has been successfully processed.

Payment Details:
- Receipt Number: ${variables.receiptNumber}
- Amount Paid: ${variables.currency} ${variables.amount}
- Date: ${variables.paymentDate}
- Payment Method: ${variables.paymentMethod.toUpperCase()}

Best regards,
SPIRELEAP Real Estate Team
        `,
        subject: `Payment Successful - ${variables.receiptNumber}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: lead.contact.email,
        subject,
        html,
        text
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Payment success email sent:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending payment success email:', error);
      throw error;
    }
  }

  /**
   * Send subscription success email to the logged-in user (after Razorpay or dummy payment).
   * @param {Object} subscription - Subscription document
   * @param {Object} user - User document (populated)
   * @param {Object} plan - Plan document (populated, optional)
   * @param {{ invoicePdfBuffer?: Buffer, fileName?: string }} opts - Optional invoice PDF attachment
   */
  async sendSubscriptionSuccessEmail(subscription, user, plan, opts = {}) {
    await this.ensureInitialized();
    try {
      if (!user || !user.email) {
        console.log('User email not available for subscription success notification');
        return null;
      }

      const variables = {
        customerName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
        amount: subscription.price || plan?.price || 0,
        currency: subscription.currency || 'INR', // Default to INR as it's common in this app
        planName: subscription.planName || plan?.name || 'Subscription Plan',
        startDate: new Date(subscription.startedAt || new Date()).toLocaleDateString(),
        endDate: subscription.endedAt ? new Date(subscription.endedAt).toLocaleDateString() : 'N/A',
        paymentMethod: subscription.provider || 'N/A'
      };

      const { html, text, subject } = await this.getTemplate('subscription-success', variables, () => ({
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 0; border: 1px solid #e1e1e1; border-radius: 8px; overflow: hidden;">
            <div style="background: #2c5aa0; color: white; padding: 30px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px;">Subscription Activated!</h1>
            </div>
            <div style="padding: 30px; background: #ffffff;">
              <p>Dear ${variables.customerName},</p>
              <p>Thank you for subscribing to <strong>${variables.planName}</strong>. Your subscription has been successfully activated and you now have access to all the premium features associated with this plan.</p>
              
              <div style="background: #f9f9f9; padding: 20px; border-radius: 6px; margin: 25px 0;">
                <h3 style="margin-top: 0; color: #2c5aa0; border-bottom: 1px solid #eee; padding-bottom: 10px;">Subscription Details</h3>
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Plan:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.planName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Amount:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.currency} ${variables.amount}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">Start Date:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.startDate}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #666;">End Date:</td>
                    <td style="padding: 8px 0; font-weight: 600; text-align: right;">${variables.endDate}</td>
                  </tr>
                </table>
              </div>
              
              <p>You can manage your subscription and view your invoices from your account dashboard.</p>
              
              <div style="text-align: center; margin-top: 30px;">
                <a href="${process.env.CLIENT_URL}/dashboard" style="background: #2c5aa0; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: 600;">Go to Dashboard</a>
              </div>
              
              <div style="text-align: center; margin-top: 40px;">
                <p>Best regards,<br><strong>SPIRELEAP Real Estate Team</strong></p>
              </div>
            </div>
            <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 12px; color: #777;">
              <p>&copy; ${new Date().getFullYear()} SPIRELEAP Real Estate CRM. All rights reserved.</p>
            </div>
          </div>
        `,
        text: `
Subscription Activated!

Dear ${variables.customerName},

Thank you for subscribing to ${variables.planName}. Your subscription has been successfully activated.

Subscription Details:
- Plan: ${variables.planName}
- Amount: ${variables.currency} ${variables.amount}
- Start Date: ${variables.startDate}
- End Date: ${variables.endDate}

Best regards,
SPIRELEAP Real Estate Team
        `,
        subject: `Subscription Activated - ${variables.planName}`
      }));

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: user.email,
        subject,
        html,
        text
      };

      if (opts.invoicePdfBuffer && Buffer.isBuffer(opts.invoicePdfBuffer)) {
        mailOptions.attachments = [
          {
            filename: opts.fileName || 'subscription-invoice.pdf',
            content: opts.invoicePdfBuffer
          }
        ];
      }

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Subscription success email sent' + (mailOptions.attachments ? ' (with invoice attachment)' : '') + ':', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending subscription success email:', error);
      throw error;
    }
  }

  /**
   * Send document(s) to customer when admin uploads property/lead documents.
   * @param {Object} lead - Lead with contact (decrypted) and optional property/agency
   * @param {Array} documents - Array of { name, url, filename } from upload
   * @param {Array} filePaths - Full paths to files on disk for attachments (optional)
   */
  async sendDocumentUploadedToCustomer(lead, documents, filePaths = []) {
    await this.ensureInitialized();
    const customerEmail = lead?.contact?.email;
    if (!customerEmail || !documents?.length) {
      console.log('EmailService: No customer email or documents for document notification');
      return null;
    }
    try {
      const firstName = lead.contact?.firstName || 'Customer';
      const agencyName = lead.agency?.name || 'SPIRELEAP';
      const propertyTitle = lead.property?.title || 'your property';

      const docList = documents.map(d => `<li><strong>${d.name || d.filename}</strong></li>`).join('');
      const attachments = [];
      if (filePaths.length > 0) {
        for (let i = 0; i < filePaths.length; i++) {
          const p = filePaths[i];
          const doc = documents[i];
          const name = doc?.name || doc?.filename || (typeof p === 'string' ? p.split(/[/\\]/).pop() : 'document');
          if (fs.existsSync(p)) {
            attachments.push({
              filename: name,
              content: fs.readFileSync(p)
            });
          }
        }
      }

      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f7f6; }
          .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
          .header { background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: white; padding: 40px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 40px 30px; }
          .greeting { font-size: 18px; color: #1e3a8a; font-weight: 600; margin-bottom: 20px; }
          .doc-list { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 25px 0; }
          .footer { background: #f9fafb; padding: 30px; text-align: center; font-size: 13px; color: #64748b; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Your Property Documents</h1>
          </div>
          <div class="content">
            <p class="greeting">Hello ${firstName},</p>
            <p>We have uploaded document(s) for <strong>${propertyTitle}</strong>.</p>
            <div class="doc-list">
              <p style="margin: 0 0 10px 0; font-size: 12px; color: #64748b; text-transform: uppercase;">Uploaded documents:</p>
              <ul style="margin: 0; padding-left: 20px;">${docList}</ul>
            </div>
            ${attachments.length > 0 ? '<p>The document(s) are attached to this email for your reference.</p>' : '<p>You can view and download these documents from your customer portal.</p>'}
            <p>Best regards,<br><strong>${agencyName} Team</strong></p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${agencyName}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
      `;

      const text = `
Hello ${firstName},

We have uploaded document(s) for ${propertyTitle}.

Uploaded documents:
${documents.map(d => `- ${d.name || d.filename}`).join('\n')}

${attachments.length > 0 ? 'The document(s) are attached to this email.' : 'You can view and download these documents from your customer portal.'}

Best regards,
${agencyName} Team
      `;

      const mailOptions = {
        from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
        to: customerEmail,
        subject: `Your property documents – ${propertyTitle}`,
        html,
        text,
        attachments: attachments.length > 0 ? attachments : undefined
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Document uploaded email sent to customer:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending document uploaded email to customer:', error);
      throw error;
    }
  }

  async sendBookingRequestNotification(property, customer, agent, agency) {
    await this.ensureInitialized();
    try {
      const recipients = [];
      if (customer?.email) recipients.push({ email: customer.email, type: 'customer' });
      if (agent?.email) recipients.push({ email: agent.email, type: 'agent' });
      if (agency?.contact?.email) recipients.push({ email: agency.contact.email, type: 'agency' });

      if (recipients.length === 0) {
        console.log('EmailService: No recipients for booking notification');
        return null;
      }

      const results = [];
      const bookingDate = new Date().toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const priceStr = property.listingType === 'rent'
        ? `₹${Number(property.price?.rent?.amount || 0).toLocaleString()}/month`
        : `₹${Number(property.price?.sale || 0).toLocaleString()}`;

      for (const recipient of recipients) {
        const variables = {
          customerName: `${customer.firstName} ${customer.lastName}`,
          customerEmail: customer.email,
          customerPhone: customer.phone || 'N/A',
          agentName: agent ? `${agent.firstName} ${agent.lastName}` : 'N/A',
          agencyName: agency?.name || 'SPIRELEAP',
          propertyTitle: property.title,
          propertyLocation: `${property.location?.address || ''}, ${property.location?.city || ''}`,
          price: priceStr,
          bookingDate: bookingDate,
          recipientType: recipient.type
        };

        const { html, text, subject } = await this.getTemplate('booking-request', variables, () => ({
          html: this.generateBookingRequestHTML(variables),
          text: this.generateBookingRequestText(variables),
          subject: recipient.type === 'customer'
            ? `Booking Confirmation: ${property.title}`
            : `Action Required: New Booking Request for ${property.title}`
        }));

        const mailOptions = {
          from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
          to: recipient.email,
          subject,
          html,
          text
        };

        const result = await this.transporter.sendMail(mailOptions);
        results.push({ email: recipient.email, messageId: result.messageId });
        console.log(`Booking notification sent to ${recipient.type}: ${recipient.email}`);
      }
      return results;
    } catch (error) {
      console.error('EmailService: Error sending booking request notifications:', error);
      return null;
    }
  }

  generateBookingRequestHTML(v) {
    const isCustomer = v.recipientType === 'customer';
    const mainTitle = isCustomer ? 'Booking Confirmation' : 'New Booking Request Received';
    const accentColor = isCustomer ? '#2c5aa0' : '#e67e22';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${mainTitle}</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; background-color: #f4f7f6; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
          .header { background: ${accentColor}; color: white; padding: 40px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 26px; font-weight: 600; }
          .content { padding: 40px 30px; }
          .welcome-text { font-size: 18px; color: ${accentColor}; font-weight: 600; margin-bottom: 20px; }
          .details-box { background: #f8f9fa; border-left: 4px solid ${accentColor}; padding: 25px; border-radius: 4px; margin: 25px 0; }
          .detail-row { display: flex; margin-bottom: 12px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
          .detail-label { width: 140px; font-weight: 600; color: #666; font-size: 14px; }
          .detail-value { flex: 1; color: #111; font-weight: 500; font-size: 14px; }
          .property-badge { display: inline-block; background: #eef2f7; color: ${accentColor}; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 10px; }
          .btn-container { text-align: center; margin: 35px 0; }
          .button { display: inline-block; background: ${accentColor}; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .footer { background: #f9f9f9; padding: 25px; text-align: center; font-size: 13px; color: #777; border-top: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${mainTitle}</h1>
          </div>
          <div class="content">
            <p class="welcome-text">Hi ${isCustomer ? v.customerName : v.agentName || 'Team'},</p>
            <p>${isCustomer
        ? `Thank you for choosing SPIRELEAP. Your booking request for the following property has been received and sent to the respective agency for approval.`
        : `A new booking request has been placed by a customer for one of your listed properties. Please review the details below and take appropriate action.`
      }</p>
            
            <div class="details-box">
              <div class="property-badge">Property Details</div>
              <div class="detail-row">
                <div class="detail-label">Property</div>
                <div class="detail-value">${v.propertyTitle}</div>
              </div>
              <div class="detail-row">
                <div class="detail-label">Location</div>
                <div class="detail-value">${v.propertyLocation}</div>
              </div>
              <div class="detail-row">
                <div class="detail-label">Price</div>
                <div class="detail-value">${v.price}</div>
              </div>
              
              <div class="property-badge" style="margin-top: 15px;">Booking Info</div>
              <div class="detail-row">
                <div class="detail-label">Date & Time</div>
                <div class="detail-value">${v.bookingDate}</div>
              </div>
              ${!isCustomer ? `
                <div class="detail-row">
                  <div class="detail-label">Customer Name</div>
                  <div class="detail-value">${v.customerName}</div>
                </div>
                <div class="detail-row">
                  <div class="detail-label">Customer Email</div>
                  <div class="detail-value">${v.customerEmail}</div>
                </div>
                <div class="detail-row">
                  <div class="detail-label">Customer Phone</div>
                  <div class="detail-value">${v.customerPhone}</div>
                </div>
              ` : `
                <div class="detail-row">
                  <div class="detail-label">Agency</div>
                  <div class="detail-value">${v.agencyName}</div>
                </div>
                <div class="detail-row">
                  <div class="detail-label">Agent</div>
                  <div class="detail-value">${v.agentName}</div>
                </div>
              `}
            </div>
            
            <p>If you have any questions, please contact our support team or reply to this email.</p>
            <p>Best regards,<br><strong>SPIRELEAP Real Estate Team</strong></p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} SPIRELEAP Real Estate CRM. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generateBookingRequestText(v) {
    const isCustomer = v.recipientType === 'customer';
    return `
${isCustomer ? 'Booking Confirmation' : 'New Booking Request Received'}

Hi ${isCustomer ? v.customerName : v.agentName || 'Team'},

${isCustomer
        ? `Thank you for choosing SPIRELEAP. Your booking request for ${v.propertyTitle} has been received.`
        : `A new booking request has been placed by ${v.customerName} for ${v.propertyTitle}.`
      }

Property Details:
- Property: ${v.propertyTitle}
- Location: ${v.propertyLocation}
- Price: ${v.price}

Booking Details:
- Date: ${v.bookingDate}
${!isCustomer ? `- Customer: ${v.customerName}\n- Email: ${v.customerEmail}\n- Phone: ${v.customerPhone}` : `- Agency: ${v.agencyName}\n- Agent: ${v.agentName}`}

Best regards,
SPIRELEAP Real Estate Team
    `;
  }
}

module.exports = new EmailService();
