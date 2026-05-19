import { prisma } from "./db";
import { logger } from "./logger";

interface AuditOptions {
  action: string;
  actorId?: string | null;
  orgId?: string | null;
  targetType?: string;
  targetId?: string;
  diff?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Records an audit entry. Writes are best-effort: failures log but never throw.
 */
export async function audit(opts: AuditOptions) {
  try {
    await prisma.auditLog.create({
      data: {
        action: opts.action,
        actorId: opts.actorId ?? null,
        orgId: opts.orgId ?? null,
        targetType: opts.targetType ?? null,
        targetId: opts.targetId ?? null,
        diff: opts.diff ? JSON.stringify(opts.diff) : null,
        ip: opts.ip ?? null,
        userAgent: opts.userAgent ?? null,
      },
    });
    logger.info(`audit:${opts.action}`, {
      actorId: opts.actorId,
      orgId: opts.orgId,
      targetType: opts.targetType,
      targetId: opts.targetId,
    });
  } catch (err) {
    logger.error("audit.write.failed", { action: opts.action, err });
  }
}
