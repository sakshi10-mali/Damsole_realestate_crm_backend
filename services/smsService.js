// SMS Service - Supports multiple SMS providers
// Currently supports Twilio, but can be extended for other providers

class SMSService {
  constructor() {
    this.provider = process.env.SMS_PROVIDER || 'twilio';
    this.enabled = process.env.SMS_ENABLED === 'true';
    
    // Initialize provider-specific client
    if (this.enabled) {
      if (this.provider === 'twilio') {
        const twilio = require('twilio');
        this.client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );
        this.fromNumber = process.env.TWILIO_PHONE_NUMBER;
      }
      // Add other providers here (e.g., AWS SNS, Nexmo, etc.)
    }
  }

  async sendSMS(to, message) {
    if (!this.enabled) {
      console.log('SMS service is disabled. Would send SMS to:', to, 'Message:', message);
      return { success: false, message: 'SMS service is disabled' };
    }

    try {
      if (this.provider === 'twilio') {
        const result = await this.client.messages.create({
          body: message,
          from: this.fromNumber,
          to: to
        });
        console.log('SMS sent successfully:', result.sid);
        return { success: true, messageId: result.sid };
      }
      
      // Add other provider implementations here
      return { success: false, message: 'SMS provider not configured' };
    } catch (error) {
      console.error('Error sending SMS:', error);
      return { success: false, error: error.message };
    }
  }

  async sendLeadNotification(lead, agent) {
    if (!agent || !agent.phone) {
      return { success: false, message: 'Agent phone number not available' };
    }

    const message = `New lead assigned: ${lead.contact.firstName} ${lead.contact.lastName} - ${lead.contact.phone}. Property: ${lead.property?.title || 'General Inquiry'}. Please check your dashboard.`;
    
    return await this.sendSMS(agent.phone, message);
  }

  async sendLeadAssignmentNotification(lead, agent) {
    if (!agent || !agent.phone) {
      return { success: false, message: 'Agent phone number not available' };
    }

    const message = `You have been assigned a new lead: ${lead.contact.firstName} ${lead.contact.lastName} (${lead.contact.phone}). Please contact them soon.`;
    
    return await this.sendSMS(agent.phone, message);
  }

  async sendFollowUpReminder(lead, agent) {
    if (!agent || !agent.phone) {
      return { success: false, message: 'Agent phone number not available' };
    }

    const message = `Reminder: Follow up with ${lead.contact.firstName} ${lead.contact.lastName} (${lead.contact.phone}) today.`;
    
    return await this.sendSMS(agent.phone, message);
  }

  async sendSiteVisitReminder(lead, agent) {
    if (!agent || !agent.phone) {
      return { success: false, message: 'Agent phone number not available' };
    }

    const visitDate = new Date(lead.siteVisit.scheduledDate).toLocaleDateString();
    const visitTime = lead.siteVisit.scheduledTime || 'TBD';
    const message = `Site Visit Reminder: ${lead.contact.firstName} ${lead.contact.lastName} on ${visitDate} at ${visitTime}. Property: ${lead.property?.title || 'TBD'}.`;
    
    return await this.sendSMS(agent.phone, message);
  }

  async sendSiteVisitConfirmation(lead) {
    if (!lead || !lead.contact.phone) {
      return { success: false, message: 'Lead phone number not available' };
    }

    const visitDate = new Date(lead.siteVisit.scheduledDate).toLocaleDateString();
    const visitTime = lead.siteVisit.scheduledTime || 'TBD';
    const message = `Your site visit is confirmed for ${visitDate} at ${visitTime}. We look forward to meeting you!`;
    
    return await this.sendSMS(lead.contact.phone, message);
  }
}

module.exports = new SMSService();

