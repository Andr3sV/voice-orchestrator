-- AlterTable
ALTER TABLE "public"."WorkspacePhoneNumber" ADD COLUMN     "elevenLabsPhoneNumberId" TEXT;

-- CreateTable
CREATE TABLE "public"."AgentPhoneNumber" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AgentPhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPhoneNumber_agentId_idx" ON "public"."AgentPhoneNumber"("agentId");

-- CreateIndex
CREATE INDEX "AgentPhoneNumber_phoneNumberId_idx" ON "public"."AgentPhoneNumber"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPhoneNumber_agentId_phoneNumberId_key" ON "public"."AgentPhoneNumber"("agentId", "phoneNumberId");

-- AddForeignKey
ALTER TABLE "public"."AgentPhoneNumber" ADD CONSTRAINT "AgentPhoneNumber_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentPhoneNumber" ADD CONSTRAINT "AgentPhoneNumber_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "public"."WorkspacePhoneNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
