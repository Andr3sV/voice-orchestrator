-- CreateTable
CREATE TABLE "public"."CallDailyAggregate" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "in_progress" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallDailyAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallDailyAggregate_workspaceId_date_idx" ON "public"."CallDailyAggregate"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CallDailyAggregate_date_workspaceId_agentId_key" ON "public"."CallDailyAggregate"("date", "workspaceId", "agentId");

-- CreateIndex
CREATE INDEX "Call_workspaceId_createdAt_idx" ON "public"."Call"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Call_workspaceId_status_createdAt_idx" ON "public"."Call"("workspaceId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."CallDailyAggregate" ADD CONSTRAINT "CallDailyAggregate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CallDailyAggregate" ADD CONSTRAINT "CallDailyAggregate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
