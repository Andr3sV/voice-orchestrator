-- Add advanced metrics fields to Call table
ALTER TABLE "Call" ADD COLUMN "amdStatus" TEXT;
ALTER TABLE "Call" ADD COLUMN "amdConfidence" DOUBLE PRECISION;
ALTER TABLE "Call" ADD COLUMN "amdDetectionTime" INTEGER;
ALTER TABLE "Call" ADD COLUMN "twilioCallSid" TEXT;
ALTER TABLE "Call" ADD COLUMN "callQuality" TEXT;
ALTER TABLE "Call" ADD COLUMN "jitter" DOUBLE PRECISION;
ALTER TABLE "Call" ADD COLUMN "packetLoss" DOUBLE PRECISION;
ALTER TABLE "Call" ADD COLUMN "mosScore" DOUBLE PRECISION;
ALTER TABLE "Call" ADD COLUMN "costTwilio" DOUBLE PRECISION;
ALTER TABLE "Call" ADD COLUMN "costElevenLabs" DOUBLE PRECISION;
ALTER TABLE "Call" ADD COLUMN "costBreakdown" JSONB;
ALTER TABLE "Call" ADD COLUMN "agentModel" TEXT;
ALTER TABLE "Call" ADD COLUMN "sipTrunkUsed" TEXT;

-- Add indexes for better performance
CREATE INDEX "Call_workspaceId_campaignId_createdAt_idx" ON "Call"("workspaceId", "campaignId", "createdAt");
CREATE INDEX "Call_workspaceId_amdStatus_createdAt_idx" ON "Call"("workspaceId", "amdStatus", "createdAt");
