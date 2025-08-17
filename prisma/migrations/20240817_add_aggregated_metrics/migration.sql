-- Add aggregated metrics fields to CallDailyAggregate table
ALTER TABLE "CallDailyAggregate" ADD COLUMN "amdStats" JSONB;
ALTER TABLE "CallDailyAggregate" ADD COLUMN "costMetrics" JSONB;
ALTER TABLE "CallDailyAggregate" ADD COLUMN "qualityMetrics" JSONB;
ALTER TABLE "CallDailyAggregate" ADD COLUMN "totalMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CallDailyAggregate" ADD COLUMN "totalCallsWithDuration" INTEGER NOT NULL DEFAULT 0;

-- Create CampaignDailyAggregate table
CREATE TABLE "CampaignDailyAggregate" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMPTZ(6) NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "totalMinutes" INTEGER NOT NULL DEFAULT 0,
    "amdStats" JSONB,
    "costMetrics" JSONB,
    "qualityMetrics" JSONB,
    "statusBreakdown" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "CampaignDailyAggregate_pkey" PRIMARY KEY ("id")
);

-- Add indexes for better performance
CREATE INDEX "CampaignDailyAggregate_workspaceId_campaignId_date_idx" ON "CampaignDailyAggregate"("workspaceId", "campaignId", "date");
CREATE INDEX "CampaignDailyAggregate_workspaceId_date_idx" ON "CampaignDailyAggregate"("workspaceId", "date");
CREATE UNIQUE INDEX "CampaignDailyAggregate_date_workspaceId_campaignId_key" ON "CampaignDailyAggregate"("date", "workspaceId", "campaignId");

-- Add foreign key constraints
ALTER TABLE "CampaignDailyAggregate" ADD CONSTRAINT "CampaignDailyAggregate_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignDailyAggregate" ADD CONSTRAINT "CampaignDailyAggregate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
