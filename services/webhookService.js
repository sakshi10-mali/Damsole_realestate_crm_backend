const axios = require('axios');

class WebhookService {
  /**
   * Send lead data to external webhook URL
   * @param {Object} lead - Lead document (populated)
   * @param {String} event - Event type (created, updated, status_changed, completed, booked, etc.)
   * @param {Object} previousData - Previous lead data (for updates)
   */
  async sendLeadWebhook(lead, event, previousData = null) {
    try {
      const webhookUrl = process.env.OUTBOUND_WEBHOOK_URL;
      
      // Skip if webhook URL not configured
      if (!webhookUrl) {
        return { success: false, message: 'Webhook URL not configured' };
      }

      // Prepare lead data for webhook
      const webhookPayload = this.formatLeadData(lead, event, previousData);

      // Send webhook
      const response = await axios.post(webhookUrl, webhookPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.OUTBOUND_WEBHOOK_API_KEY || '',
          'X-Event-Type': event,
          'User-Agent': 'CRM-Webhook-Service/1.0'
        },
        timeout: 10000 // 10 seconds timeout
      });

      console.log(`✅ Webhook sent successfully for lead ${lead._id}, event: ${event}`);
      return { success: true, response: response.data };
    } catch (error) {
      console.error(`❌ Webhook error for lead ${lead._id}, event: ${event}:`, error.message);
      
      // Don't throw error, just log it
      // This ensures lead operations don't fail if webhook fails
      return { 
        success: false, 
        error: error.message,
        response: error.response?.data || null
      };
    }
  }

  /**
   * Format lead data for webhook payload
   */
  formatLeadData(lead, event, previousData = null) {
    const payload = {
      event: event,
      timestamp: new Date().toISOString(),
      lead: {
        id: lead._id?.toString(),
        leadId: lead.leadId,
        status: lead.status,
        priority: lead.priority,
        source: lead.source,
        campaignName: lead.campaignName,
        score: lead.score || 0,
        scoreDetails: lead.scoreDetails || {},
        contact: {
          firstName: lead.contact?.firstName || '',
          lastName: lead.contact?.lastName || '',
          email: lead.contact?.email || '',
          phone: lead.contact?.phone || '',
          alternatePhone: lead.contact?.alternatePhone || '',
          address: lead.contact?.address || {}
        },
        inquiry: {
          message: lead.inquiry?.message || '',
          budget: lead.inquiry?.budget || {},
          timeline: lead.inquiry?.timeline || '',
          requirements: lead.inquiry?.requirements || '',
          preferredLocation: lead.inquiry?.preferredLocation || [],
          propertyType: lead.inquiry?.propertyType || []
        },
        property: lead.property ? {
          id: lead.property._id?.toString(),
          title: lead.property.title,
          slug: lead.property.slug
        } : null,
        agency: lead.agency ? {
          id: lead.agency._id?.toString(),
          name: lead.agency.name || (typeof lead.agency === 'object' ? lead.agency.name : null)
        } : null,
        assignedAgent: lead.assignedAgent ? {
          id: lead.assignedAgent._id?.toString(),
          firstName: lead.assignedAgent.firstName || '',
          lastName: lead.assignedAgent.lastName || '',
          email: lead.assignedAgent.email || ''
        } : null,
        siteVisit: lead.siteVisit ? {
          scheduledDate: lead.siteVisit.scheduledDate,
          scheduledTime: lead.siteVisit.scheduledTime,
          completedDate: lead.siteVisit.completedDate,
          status: lead.siteVisit.status,
          feedback: lead.siteVisit.feedback,
          interestLevel: lead.siteVisit.interestLevel,
          nextAction: lead.siteVisit.nextAction
        } : null,
        booking: lead.booking ? {
          unitNumber: lead.booking.unitNumber,
          flatNumber: lead.booking.flatNumber,
          bookingAmount: lead.booking.bookingAmount,
          paymentMode: lead.booking.paymentMode,
          agreementStatus: lead.booking.agreementStatus,
          bookingDate: lead.booking.bookingDate
        } : null,
        sla: lead.sla ? {
          firstContactAt: lead.sla.firstContactAt,
          firstContactStatus: lead.sla.firstContactStatus,
          responseTime: lead.sla.responseTime,
          lastContactAt: lead.sla.lastContactAt
        } : null,
        communicationsCount: lead.communications?.length || 0,
        remindersCount: lead.reminders?.length || 0,
        tags: lead.tags || [],
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt,
        convertedAt: lead.convertedAt,
        lostReason: lead.lostReason
      }
    };

    // Add previous data for update events
    if (previousData && event.includes('updated') || event === 'status_changed') {
      payload.previous = {
        status: previousData.status,
        priority: previousData.priority,
        assignedAgent: previousData.assignedAgent
      };
    }

    return payload;
  }

  /**
   * Send all leads to webhook (bulk export)
   * @param {Array} leads - Array of lead documents
   * @param {String} event - Event type (bulk_export, sync, etc.)
   */
  async sendBulkLeadsWebhook(leads, event = 'bulk_export') {
    try {
      const webhookUrl = process.env.OUTBOUND_WEBHOOK_URL;
      
      if (!webhookUrl) {
        return { success: false, message: 'Webhook URL not configured' };
      }

      const payload = {
        event: event,
        timestamp: new Date().toISOString(),
        totalLeads: leads.length,
        leads: leads.map(lead => this.formatLeadData(lead, 'bulk_export').lead)
      };

      const response = await axios.post(webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.OUTBOUND_WEBHOOK_API_KEY || '',
          'X-Event-Type': event,
          'User-Agent': 'CRM-Webhook-Service/1.0'
        },
        timeout: 30000 // 30 seconds for bulk operations
      });

      console.log(`✅ Bulk webhook sent successfully: ${leads.length} leads`);
      return { success: true, response: response.data };
    } catch (error) {
      console.error(`❌ Bulk webhook error:`, error.message);
      return { 
        success: false, 
        error: error.message,
        response: error.response?.data || null
      };
    }
  }

  /**
   * Check if webhook is enabled
   */
  isEnabled() {
    return !!process.env.OUTBOUND_WEBHOOK_URL;
  }
}

module.exports = new WebhookService();

