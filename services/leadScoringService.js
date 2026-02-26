const Lead = require('../models/Lead');

class LeadScoringService {
  /**
   * Calculate lead score based on multiple factors
   * Returns score from 0-100
   */
  calculateLeadScore(lead) {
    let score = 0;
    const details = {
      sourceScore: 0,
      budgetScore: 0,
      timelineScore: 0,
      engagementScore: 0
    };

    // 1. Source Score (0-25 points)
    const sourceScores = {
      'referral': 25,
      'walk_in': 20,
      'phone': 18,
      'email': 15,
      'website': 12,
      'social_media': 10,
      'other': 5
    };
    details.sourceScore = sourceScores[lead.source] || 5;
    score += details.sourceScore;

    // 2. Budget Score (0-25 points)
    if (lead.inquiry?.budget) {
      // Convert to numbers and handle edge cases
      const min = typeof lead.inquiry.budget.min === 'number'
        ? lead.inquiry.budget.min
        : (lead.inquiry.budget.min ? parseFloat(lead.inquiry.budget.min) : null);
      const max = typeof lead.inquiry.budget.max === 'number'
        ? lead.inquiry.budget.max
        : (lead.inquiry.budget.max ? parseFloat(lead.inquiry.budget.max) : null);

      // Only calculate if at least one valid number exists
      if (min !== null && !isNaN(min) && min > 0) {
        let budgetValue = min;

        // If both min and max exist, use average
        if (max !== null && !isNaN(max) && max > 0) {
          budgetValue = (min + max) / 2;
        }

        // Higher budget = higher score (up to 25 points)
        if (budgetValue >= 1000000) details.budgetScore = 25;
        else if (budgetValue >= 500000) details.budgetScore = 20;
        else if (budgetValue >= 250000) details.budgetScore = 15;
        else if (budgetValue >= 100000) details.budgetScore = 10;
        else if (budgetValue >= 50000) details.budgetScore = 5;
        else if (budgetValue > 0) details.budgetScore = 2; // Small budget still gets some points
      } else if (max !== null && !isNaN(max) && max > 0) {
        // Only max is provided
        if (max >= 1000000) details.budgetScore = 25;
        else if (max >= 500000) details.budgetScore = 20;
        else if (max >= 250000) details.budgetScore = 15;
        else if (max >= 100000) details.budgetScore = 10;
        else if (max >= 50000) details.budgetScore = 5;
        else if (max > 0) details.budgetScore = 2;
      }
    }
    score += details.budgetScore;

    // 3. Timeline Score (0-25 points)
    const timelineScores = {
      'immediate': 25,
      '1_month': 20,
      '3_months': 15,
      '6_months': 10,
      '1_year': 5,
      'flexible': 3
    };
    if (lead.inquiry?.timeline) {
      details.timelineScore = timelineScores[lead.inquiry.timeline] || 0;
    }
    score += details.timelineScore;

    // 4. Engagement Score (0-25 points)
    let engagementScore = 0;
    // Has property inquiry
    if (lead.property) engagementScore += 5;
    // Has detailed message
    if (lead.inquiry?.message && lead.inquiry.message.length > 50) engagementScore += 5;
    // Has preferred location
    if (lead.inquiry?.preferredLocation && lead.inquiry.preferredLocation.length > 0) engagementScore += 5;
    // Has property type preference
    if (lead.inquiry?.propertyType && lead.inquiry.propertyType.length > 0) engagementScore += 5;
    // Has communications
    if (lead.communications && lead.communications.length > 0) engagementScore += 5;
    details.engagementScore = Math.min(engagementScore, 25);
    score += details.engagementScore;

    // Cap score at 100
    score = Math.min(score, 100);

    return {
      score: Math.round(score),
      details: {
        ...details,
        lastCalculatedAt: new Date()
      }
    };
  }

  /**
   * Determine priority based on score
   */
  getPriorityFromScore(score) {
    if (score >= 70) return 'Hot';
    if (score >= 10) return 'Warm';
    return 'Warm';
  }

  /**
   * Auto-score a lead and update priority
   */
  async autoScoreLead(leadId, shouldUpdatePriority = true) {
    try {
      const lead = await Lead.findById(leadId);
      if (!lead) {
        throw new Error('Lead not found');
      }

      const { score, details } = this.calculateLeadScore(lead);
      const priority = this.getPriorityFromScore(score);

      lead.score = score;
      lead.scoreDetails = details;

      // Auto-update priority if enabled and allowed
      if (shouldUpdatePriority) {
        // Always update priority based on score for new inquiries/updates
        lead.priority = priority;
      }

      await lead.save();
      return { score, priority, details };
    } catch (error) {
      console.error('Auto-score lead error:', error);
      throw error;
    }
  }
}

module.exports = new LeadScoringService();

