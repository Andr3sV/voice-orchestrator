import { prisma } from './prisma.js';
import { logger } from './logger.js';

export interface AMDStats {
  totalCalls: number;
  amdStats: {
    human: number;
    machine: number;
    unknown: number;
  };
  amdEfficiency: {
    humanDetectionRate: number;
    machineDetectionRate: number;
    falsePositiveRate: number;
  };
  costSavings: {
    voicemailsAvoided: number;
    estimatedSavings: number;
  };
}

export interface CostMetrics {
  totalMinutes: number;
  costBreakdown: {
    twilio: number;
    elevenLabs: number;
    total: number;
  };
  costPerMinute: number;
  costPerCall: number;
  savingsFromAMD: number;
  roi?: {
    totalCost: number;
    estimatedValue: number;
    roiPercentage: number;
  };
}

export interface QualityMetrics {
  averageCallQuality: string;
  qualityDistribution: {
    excellent: number;
    good: number;
    fair: number;
    poor: number;
  };
  technicalMetrics: {
    averageJitter: number;
    averagePacketLoss: number;
    averageMOS: number;
  };
}

export interface CampaignDashboard {
  campaignId: string;
  period: {
    from: string;
    to: string;
  };
  overview: {
    totalCalls: number;
    totalMinutes: number;
    totalCost: number;
    conversionRate: number;
  };
  amdPerformance: AMDStats;
  costAnalysis: CostMetrics;
  qualityMetrics: QualityMetrics;
}

export class MetricsService {
  /**
   * Get AMD statistics for a workspace or campaign
   * Uses aggregated data when available for better performance
   */
  async getAMDStats(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<AMDStats> {
    // Try to use aggregated data first for better performance
    if (this.shouldUseAggregatedData(params.from, params.to)) {
      return this.getAMDStatsFromAggregated(params);
    }

    // Fallback to individual call data
    return this.getAMDStatsFromCalls(params);
  }

  /**
   * Check if we should use aggregated data based on date range
   */
  private shouldUseAggregatedData(from: Date, to: Date): boolean {
    const daysDiff = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    // Use aggregated data for ranges longer than 15 days (retention period)
    return daysDiff > 15;
  }

  /**
   * Get AMD stats from aggregated data (CallDailyAggregate or CampaignDailyAggregate)
   */
  private async getAMDStatsFromAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<AMDStats> {
    if (params.campaignId) {
      return this.getAMDStatsFromCampaignAggregated({
        workspaceId: params.workspaceId,
        from: params.from,
        to: params.to,
        campaignId: params.campaignId,
      });
    } else {
      return this.getAMDStatsFromWorkspaceAggregated(params);
    }
  }

  /**
   * Get AMD stats from workspace aggregated data
   */
  private async getAMDStatsFromWorkspaceAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
  }): Promise<AMDStats> {
    const aggregates = await prisma.callDailyAggregate.findMany({
      where: {
        workspaceId: params.workspaceId,
        date: { gte: params.from, lte: params.to },
        amdStats: { not: null as any }
      },
      select: {
        amdStats: true,
        total: true,
      }
    });

    return this.calculateAMDStatsFromAggregates(aggregates);
  }

  /**
   * Get AMD stats from campaign aggregated data
   */
  private async getAMDStatsFromCampaignAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId: string;
  }): Promise<AMDStats> {
    const aggregates = await prisma.campaignDailyAggregate.findMany({
      where: {
        workspaceId: params.workspaceId,
        campaignId: params.campaignId,
        date: { gte: params.from, lte: params.to },
        amdStats: { not: null as any }
      },
      select: {
        amdStats: true,
        totalCalls: true,
      }
    });

    return this.calculateAMDStatsFromAggregates(aggregates, 'totalCalls');
  }

  /**
   * Calculate AMD stats from aggregated data
   */
  private calculateAMDStatsFromAggregates(aggregates: any[], totalField: string = 'total'): AMDStats {
    let totalCalls = 0;
    let totalHuman = 0;
    let totalMachine = 0;
    let totalUnknown = 0;

    for (const aggregate of aggregates) {
      const amdStats = aggregate.amdStats as any;
      const count = aggregate[totalField] || 0;
      
      totalCalls += count;
      totalHuman += (amdStats.human || 0);
      totalMachine += (amdStats.machine || 0);
      totalUnknown += (amdStats.unknown || 0);
    }

    const totalDetected = totalHuman + totalMachine + totalUnknown;
    const humanDetectionRate = totalDetected > 0 ? totalHuman / totalDetected : 0;
    const machineDetectionRate = totalDetected > 0 ? totalMachine / totalDetected : 0;
    const falsePositiveRate = totalDetected > 0 ? totalUnknown / totalDetected : 0;

    // Estimate cost savings (avoiding voicemails)
    const voicemailsAvoided = totalMachine;
    const estimatedSavings = voicemailsAvoided * 0.15; // $0.15 per voicemail avoided

    return {
      totalCalls,
      amdStats: {
        human: totalHuman,
        machine: totalMachine,
        unknown: totalUnknown,
      },
      amdEfficiency: {
        humanDetectionRate,
        machineDetectionRate,
        falsePositiveRate,
      },
      costSavings: {
        voicemailsAvoided,
        estimatedSavings,
      },
    };
  }

  /**
   * Get AMD stats from individual call data (fallback method)
   */
  private async getAMDStatsFromCalls(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<AMDStats> {
    const where: any = {
      workspaceId: params.workspaceId,
      createdAt: { gte: params.from, lte: params.to },
    };

    if (params.campaignId) {
      where.campaignId = params.campaignId;
    }

    const calls = await prisma.call.findMany({
      where,
      select: {
        amdStatus: true,
        amdConfidence: true,
        costElevenLabs: true,
      },
    });

    const totalCalls = calls.length;
    const amdStats = {
      human: calls.filter(c => c.amdStatus === 'human').length,
      machine: calls.filter(c => c.amdStatus === 'machine').length,
      unknown: calls.filter(c => !c.amdStatus || c.amdStatus === 'unknown').length,
    };

    const humanDetectionRate = totalCalls > 0 ? (amdStats.human / totalCalls) * 100 : 0;
    const machineDetectionRate = totalCalls > 0 ? (amdStats.machine / totalCalls) * 100 : 0;
    const falsePositiveRate = totalCalls > 0 ? (amdStats.unknown / totalCalls) * 100 : 0;

    // Estimate cost savings from AMD (avoiding voicemails)
    const voicemailsAvoided = amdStats.machine;
    const estimatedSavings = voicemailsAvoided * 0.15; // Assuming $0.15 per voicemail

    return {
      totalCalls,
      amdStats,
      amdEfficiency: {
        humanDetectionRate,
        machineDetectionRate,
        falsePositiveRate,
      },
      costSavings: {
        voicemailsAvoided,
        estimatedSavings,
      },
    };
  }

  /**
   * Get cost analysis for a workspace or campaign
   * Uses aggregated data when available for better performance
   */
  async getCostMetrics(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<CostMetrics> {
    // Try to use aggregated data first for better performance
    if (this.shouldUseAggregatedData(params.from, params.to)) {
      return this.getCostMetricsFromAggregated(params);
    }

    // Fallback to individual call data
    return this.getCostMetricsFromCalls(params);
  }

  /**
   * Get cost metrics from aggregated data
   */
  private async getCostMetricsFromAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<CostMetrics> {
    if (params.campaignId) {
      return this.getCostMetricsFromCampaignAggregated({
        workspaceId: params.workspaceId,
        from: params.from,
        to: params.to,
        campaignId: params.campaignId,
      });
    } else {
      return this.getCostMetricsFromWorkspaceAggregated(params);
    }
  }

  /**
   * Get cost metrics from workspace aggregated data
   */
  private async getCostMetricsFromWorkspaceAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
  }): Promise<CostMetrics> {
    const aggregates = await prisma.callDailyAggregate.findMany({
      where: {
        workspaceId: params.workspaceId,
        date: { gte: params.from, lte: params.to },
        costMetrics: { not: null as any }
      },
      select: {
        costMetrics: true,
        total: true,
        totalMinutes: true,
      }
    });

    return this.calculateCostMetricsFromAggregates(aggregates, 'total');
  }

  /**
   * Get cost metrics from campaign aggregated data
   */
  private async getCostMetricsFromCampaignAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId: string;
  }): Promise<CostMetrics> {
    const aggregates = await prisma.campaignDailyAggregate.findMany({
      where: {
        workspaceId: params.workspaceId,
        campaignId: params.campaignId,
        date: { gte: params.from, lte: params.to },
        costMetrics: { not: null as any }
      },
      select: {
        costMetrics: true,
        totalCalls: true,
        totalMinutes: true,
      }
    });

    return this.calculateCostMetricsFromAggregates(aggregates, 'totalCalls');
  }

  /**
   * Calculate cost metrics from aggregated data
   */
  private calculateCostMetricsFromAggregates(aggregates: any[], totalField: string = 'total'): CostMetrics {
    let totalCalls = 0;
    let totalMinutes = 0;
    let totalTwilioCost = 0;
    let totalElevenLabsCost = 0;

    for (const aggregate of aggregates) {
      const costMetrics = aggregate.costMetrics as any;
      const count = aggregate[totalField] || 0;
      const minutes = aggregate.totalMinutes || 0;
      
      totalCalls += count;
      totalMinutes += minutes;
      totalTwilioCost += (costMetrics.twilio || 0);
      totalElevenLabsCost += (costMetrics.elevenLabs || 0);
    }

    const totalCost = totalTwilioCost + totalElevenLabsCost;
    const costPerMinute = totalMinutes > 0 ? totalCost / (totalMinutes / 60) : 0;
    const costPerCall = totalCalls > 0 ? totalCost / totalCalls : 0;

    // Estimate savings from AMD (avoiding voicemails)
    const savingsFromAMD = totalTwilioCost * 0.6; // Assume 60% of Twilio calls are voicemails

    return {
      totalMinutes: totalMinutes / 60, // Convert to minutes
      costBreakdown: {
        twilio: totalTwilioCost,
        elevenLabs: totalElevenLabsCost,
        total: totalCost,
      },
      costPerMinute,
      costPerCall,
      savingsFromAMD,
    };
  }

  /**
   * Get cost metrics from individual call data (fallback method)
   */
  private async getCostMetricsFromCalls(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<CostMetrics> {
    const where: any = {
      workspaceId: params.workspaceId,
      createdAt: { gte: params.from, lte: params.to },
    };

    if (params.campaignId) {
      where.campaignId = params.campaignId;
    }

    const calls = await prisma.call.findMany({
      where,
      select: {
        costTwilio: true,
        costElevenLabs: true,
        durationSeconds: true,
        amdStatus: true,
      },
    });

    const totalCalls = calls.length;
    const totalMinutes = calls.reduce((sum, call) => sum + (call.durationSeconds || 0), 0) / 60;
    
    const costTwilio = calls.reduce((sum, call) => sum + (call.costTwilio || 0), 0);
    const costElevenLabs = calls.reduce((sum, call) => sum + (call.costElevenLabs || 0), 0);
    const total = costTwilio + costElevenLabs;

    const costPerMinute = totalMinutes > 0 ? total / totalMinutes : 0;
    const costPerCall = totalCalls > 0 ? total / totalCalls : 0;

    // Calculate savings from AMD
    const voicemailsAvoided = calls.filter(c => c.amdStatus === 'machine').length;
    const savingsFromAMD = voicemailsAvoided * 0.15; // $0.15 per voicemail avoided

    return {
      totalMinutes,
      costBreakdown: {
        twilio: costTwilio,
        elevenLabs: costElevenLabs,
        total,
      },
      costPerMinute,
      costPerCall,
      savingsFromAMD,
    };
  }

  /**
   * Get quality metrics for a workspace or campaign
   * Uses aggregated data when available for better performance
   */
  async getQualityMetrics(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<QualityMetrics> {
    // Try to use aggregated data first for better performance
    if (this.shouldUseAggregatedData(params.from, params.to)) {
      return this.getQualityMetricsFromAggregated(params);
    }

    // Fallback to individual call data
    return this.getQualityMetricsFromCalls(params);
  }

  /**
   * Get quality metrics from aggregated data
   */
  private async getQualityMetricsFromAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<QualityMetrics> {
    if (params.campaignId) {
      return this.getQualityMetricsFromCampaignAggregated({
        workspaceId: params.workspaceId,
        from: params.from,
        to: params.to,
        campaignId: params.campaignId,
      });
    } else {
      return this.getQualityMetricsFromWorkspaceAggregated(params);
    }
  }

  /**
   * Get quality metrics from workspace aggregated data
   */
  private async getQualityMetricsFromWorkspaceAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
  }): Promise<QualityMetrics> {
    const aggregates = await prisma.callDailyAggregate.findMany({
      where: {
        workspaceId: params.workspaceId,
        date: { gte: params.from, lte: params.to },
        qualityMetrics: { not: null as any }
      },
      select: {
        qualityMetrics: true,
        total: true,
      }
    });

    return this.calculateQualityMetricsFromAggregates(aggregates, 'total');
  }

  /**
   * Get quality metrics from campaign aggregated data
   */
  private async getQualityMetricsFromCampaignAggregated(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId: string;
  }): Promise<QualityMetrics> {
    const aggregates = await prisma.campaignDailyAggregate.findMany({
      where: {
        workspaceId: params.workspaceId,
        campaignId: params.campaignId,
        date: { gte: params.from, lte: params.to },
        qualityMetrics: { not: null as any }
      },
      select: {
        qualityMetrics: true,
        totalCalls: true,
      }
    });

    return this.calculateQualityMetricsFromAggregates(aggregates, 'totalCalls');
  }

  /**
   * Calculate quality metrics from aggregated data
   */
  private calculateQualityMetricsFromAggregates(aggregates: any[], totalField: string = 'total'): QualityMetrics {
    let totalCalls = 0;
    let totalExcellent = 0;
    let totalGood = 0;
    let totalFair = 0;
    let totalPoor = 0;
    let totalMOS = 0;
    let mosCount = 0;

    for (const aggregate of aggregates) {
      const qualityMetrics = aggregate.qualityMetrics as any;
      const count = aggregate[totalField] || 0;
      
      totalCalls += count;
      totalExcellent += (qualityMetrics.excellent || 0);
      totalGood += (qualityMetrics.good || 0);
      totalFair += (qualityMetrics.fair || 0);
      totalPoor += (qualityMetrics.poor || 0);
      
      if (qualityMetrics.averageMOS) {
        totalMOS += qualityMetrics.averageMOS;
        mosCount++;
      }
    }

    const qualityDistribution = {
      excellent: totalExcellent,
      good: totalGood,
      fair: totalFair,
      poor: totalPoor,
    };

    // Calculate average quality
    const qualityScores = { excellent: 4, good: 3, fair: 2, poor: 1 };
    const totalQualityScore = (totalExcellent * 4) + (totalGood * 3) + (totalFair * 2) + (totalPoor * 1);
    const averageQualityScore = totalCalls > 0 ? totalQualityScore / totalCalls : 0;

    let averageCallQuality = 'unknown';
    if (averageQualityScore >= 3.5) averageCallQuality = 'excellent';
    else if (averageQualityScore >= 2.5) averageCallQuality = 'good';
    else if (averageQualityScore >= 1.5) averageCallQuality = 'fair';
    else averageCallQuality = 'poor';

    // Calculate technical metrics averages
    const averageMOS = mosCount > 0 ? totalMOS / mosCount : 0;

    return {
      averageCallQuality,
      qualityDistribution,
      technicalMetrics: {
        averageJitter: 0, // Not available in aggregated data
        averagePacketLoss: 0, // Not available in aggregated data
        averageMOS,
      },
    };
  }

  /**
   * Get quality metrics from individual call data (fallback method)
   */
  private async getQualityMetricsFromCalls(params: {
    workspaceId: string;
    from: Date;
    to: Date;
    campaignId?: string;
  }): Promise<QualityMetrics> {
    const where: any = {
      workspaceId: params.workspaceId,
      createdAt: { gte: params.from, lte: params.to },
      callQuality: { not: null },
    };

    if (params.campaignId) {
      where.campaignId = params.campaignId;
    }

    const calls = await prisma.call.findMany({
      where,
      select: {
        callQuality: true,
        jitter: true,
        packetLoss: true,
        mosScore: true,
      },
    });

    const totalCalls = calls.length;
    if (totalCalls === 0) {
      return {
        averageCallQuality: 'unknown',
        qualityDistribution: { excellent: 0, good: 0, fair: 0, poor: 0 },
        technicalMetrics: { averageJitter: 0, averagePacketLoss: 0, averageMOS: 0 },
      };
    }

    const qualityDistribution = {
      excellent: calls.filter(c => c.callQuality === 'excellent').length,
      good: calls.filter(c => c.callQuality === 'good').length,
      fair: calls.filter(c => c.callQuality === 'fair').length,
      poor: calls.filter(c => c.callQuality === 'poor').length,
    };

    // Calculate average quality
    const qualityScores = { excellent: 4, good: 3, fair: 2, poor: 1 };
    const totalQualityScore = calls.reduce((sum, call) => {
      return sum + (qualityScores[call.callQuality as keyof typeof qualityScores] || 0);
    }, 0);
    const averageQualityScore = totalQualityScore / totalCalls;

    let averageCallQuality = 'unknown';
    if (averageQualityScore >= 3.5) averageCallQuality = 'excellent';
    else if (averageQualityScore >= 2.5) averageCallQuality = 'good';
    else if (averageQualityScore >= 1.5) averageCallQuality = 'fair';
    else averageCallQuality = 'poor';

    // Calculate technical metrics averages
    const validJitter = calls.filter(c => c.jitter !== null).map(c => c.jitter!);
    const validPacketLoss = calls.filter(c => c.packetLoss !== null).map(c => c.packetLoss!);
    const validMOS = calls.filter(c => c.mosScore !== null).map(c => c.mosScore!);

    const averageJitter = validJitter.length > 0 ? validJitter.reduce((a, b) => a + b, 0) / validJitter.length : 0;
    const averagePacketLoss = validPacketLoss.length > 0 ? validPacketLoss.reduce((a, b) => a + b, 0) / validPacketLoss.length : 0;
    const averageMOS = validMOS.length > 0 ? validMOS.reduce((a, b) => a + b, 0) / validMOS.length : 0;

    return {
      averageCallQuality,
      qualityDistribution,
      technicalMetrics: {
        averageJitter,
        averagePacketLoss,
        averageMOS,
      },
    };
  }

  /**
   * Get comprehensive campaign dashboard
   */
  async getCampaignDashboard(params: {
    workspaceId: string;
    campaignId: string;
    from: Date;
    to: Date;
  }): Promise<CampaignDashboard> {
    const [amdStats, costMetrics, qualityMetrics, overview] = await Promise.all([
      this.getAMDStats(params),
      this.getCostMetrics(params),
      this.getQualityMetrics(params),
      this.getCampaignOverview(params),
    ]);

    return {
      campaignId: params.campaignId,
      period: {
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      },
      overview,
      amdPerformance: amdStats,
      costAnalysis: costMetrics,
      qualityMetrics,
    };
  }

  /**
   * Get campaign overview metrics
   */
  private async getCampaignOverview(params: {
    workspaceId: string;
    campaignId: string;
    from: Date;
    to: Date;
  }) {
    const calls = await prisma.call.findMany({
      where: {
        workspaceId: params.workspaceId,
        campaignId: params.campaignId,
        createdAt: { gte: params.from, lte: params.to },
      },
      select: {
        status: true,
        durationSeconds: true,
        costTwilio: true,
        costElevenLabs: true,
        amdStatus: true,
      },
    });

    const totalCalls = calls.length;
    const totalMinutes = calls.reduce((sum, call) => sum + (call.durationSeconds || 0), 0) / 60;
    const totalCost = calls.reduce((sum, call) => {
      return sum + (call.costTwilio || 0) + (call.costElevenLabs || 0);
    }, 0);

    const humanCalls = calls.filter(c => c.amdStatus === 'human').length;
    const conversionRate = totalCalls > 0 ? (humanCalls / totalCalls) * 100 : 0;

    return {
      totalCalls,
      totalMinutes,
      totalCost,
      conversionRate,
    };
  }

  /**
   * Get workspace overview metrics
   */
  async getWorkspaceOverview(params: {
    workspaceId: string;
    from: Date;
    to: Date;
  }) {
    const [amdStats, costMetrics, qualityMetrics] = await Promise.all([
      this.getAMDStats(params),
      this.getCostMetrics(params),
      this.getQualityMetrics(params),
    ]);

    return {
      period: {
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      },
      amdPerformance: amdStats,
      costAnalysis: costMetrics,
      qualityMetrics,
    };
  }
}

export const metricsService = new MetricsService();
