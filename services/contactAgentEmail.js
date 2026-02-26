// Contact Agent Request Email Methods
// To be added to emailService.js

async function sendContactAgentRequest(lead, agent, agency) {
    await this.ensureInitialized();
    try {
        if (!agent || !agent.email) {
            console.log('Agent email not available for contact agent request');
            return null;
        }

        const propertyTitle = lead.property?.title || 'General Inquiry';
        const propertyLocation = lead.property?.location
            ? `${lead.property.location.city || ''}, ${lead.property.location.state || ''}`.trim()
            : 'N/A';
        const propertyPrice = lead.property?.price?.sale
            ? `$${Number(lead.property.price.sale).toLocaleString()}`
            : lead.property?.price?.rent?.amount
                ? `$${Number(lead.property.price.rent.amount).toLocaleString()}/${lead.property.price.rent.period || 'month'}`
                : 'Contact for price';

        const variables = {
            agentFirstName: agent.firstName,
            agentLastName: agent.lastName,
            customerFirstName: lead.contact.firstName,
            customerLastName: lead.contact.lastName,
            customerEmail: lead.contact.email,
            customerPhone: lead.contact.phone || 'Not provided',
            propertyTitle: propertyTitle,
            propertyLocation: propertyLocation,
            propertyPrice: propertyPrice,
            inquiryMessage: lead.inquiry?.message || 'No message provided',
            agencyName: agency?.name || 'SPIRELEAP'
        };

        const { html, text, subject } = await this.getTemplate('contact-agent-request', variables, () => ({
            html: this.generateContactAgentRequestHTML(variables),
            text: this.generateContactAgentRequestText(variables),
            subject: `Contact Request: ${variables.customerFirstName} ${variables.customerLastName} - ${propertyTitle}`
        }));

        const mailOptions = {
            from: `"${this.fromName}" <${this.fromEmail || this.smtpUser}>`,
            to: agent.email,
            subject,
            html,
            text,
            replyTo: lead.contact.email // Allow agent to reply directly to customer
        };

        const result = await this.transporter.sendMail(mailOptions);
        console.log('Contact agent request email sent:', result.messageId);
        return result;
    } catch (error) {
        console.error('Error sending contact agent request email:', error);
        throw error;
    }
}

function generateContactAgentRequestHTML(v) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Contact Agent Request</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; background-color: #f9fafb; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .header { background: linear-gradient(135deg, #2c5aa0 0%, #1e3a6d 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
        .content { padding: 40px; }
        .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px; }
        .details-box { background: #f3f4f6; padding: 25px; border-radius: 8px; margin: 25px 0; }
        .detail-row { display: flex; margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
        .detail-label { width: 140px; color: #6b7280; font-weight: 600; font-size: 14px; }
        .detail-value { flex: 1; color: #111827; font-size: 14px; }
        .message-box { background: #eff6ff; border-left: 4px solid #3b82f6; padding: 20px; margin: 20px 0; border-radius: 4px; }
        .btn-container { text-align: center; margin: 30px 0; }
        .button { display: inline-block; background: #2c5aa0; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; box-shadow: 0 4px 6px rgba(44, 90, 160, 0.2); }
        .footer { text-align: center; padding: 25px; font-size: 13px; color: #9ca3af; border-top: 1px solid #f3f4f6; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📞 Contact Request from Customer</h1>
        </div>
        <div class="content">
          <p>Dear ${v.agentFirstName} ${v.agentLastName},</p>
          <p>A customer has requested to be contacted regarding a property inquiry.</p>
          
          <div class="alert-box">
            <p style="margin: 0;"><strong>⏰ Action Required:</strong> Please reach out to the customer as soon as possible.</p>
          </div>

          <div class="details-box">
            <h3 style="margin-top:0; color: #111827;">Customer Information</h3>
            <div class="detail-row">
              <div class="detail-label">Name</div>
              <div class="detail-value">${v.customerFirstName} ${v.customerLastName}</div>
            </div>
            <div class="detail-row">
              <div class="detail-label">Email</div>
              <div class="detail-value"><a href="mailto:${v.customerEmail}" style="color: #2c5aa0;">${v.customerEmail}</a></div>
            </div>
            <div class="detail-row">
              <div class="detail-label">Phone</div>
              <div class="detail-value"><a href="tel:${v.customerPhone}" style="color: #2c5aa0;">${v.customerPhone}</a></div>
            </div>
          </div>

          <div class="details-box">
            <h3 style="margin-top:0; color: #111827;">Property Details</h3>
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
              <div class="detail-value">${v.propertyPrice}</div>
            </div>
          </div>

          ${v.inquiryMessage !== 'No message provided' ? `
            <div class="message-box">
              <h4 style="margin-top:0; color: #1e40af;">Customer's Message:</h4>
              <p style="margin-bottom:0; white-space: pre-wrap;">${v.inquiryMessage}</p>
            </div>
          ` : ''}
          
          <div class="btn-container">
            <a href="${process.env.CLIENT_URL}/agency/leads" class="button">View Lead in CRM</a>
          </div>
          
          <p style="background: #f9fafb; padding: 15px; border-radius: 6px; font-size: 14px; color: #6b7280;">
            <strong>💡 Pro Tip:</strong> You can reply directly to this email to contact the customer at ${v.customerEmail}
          </p>
          
          <p>Best regards,<br><strong>SPIRELEAP CRM System</strong></p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} ${v.agencyName}. All rights reserved.</p>
          <p>This is an automated notification from SPIRELEAP CRM.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function generateContactAgentRequestText(v) {
    return `
Contact Request from Customer

Dear ${v.agentFirstName} ${v.agentLastName},

A customer has requested to be contacted regarding a property inquiry.

Customer Information:
- Name: ${v.customerFirstName} ${v.customerLastName}
- Email: ${v.customerEmail}
- Phone: ${v.customerPhone}

Property Details:
- Property: ${v.propertyTitle}
- Location: ${v.propertyLocation}
- Price: ${v.propertyPrice}

${v.inquiryMessage !== 'No message provided' ? `Customer's Message:\n${v.inquiryMessage}\n\n` : ''}
Please reach out to the customer as soon as possible.

View lead in CRM: ${process.env.CLIENT_URL}/agency/leads

You can reply directly to this email to contact the customer.

Best regards,
SPIRELEAP CRM System
  `;
}

module.exports = {
    sendContactAgentRequest,
    generateContactAgentRequestHTML,
    generateContactAgentRequestText
};
