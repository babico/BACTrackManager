import { and, bacReadings, desc, eq, getDb, gte, lte, organizationMemberships, organizations, users } from "@bactrack/db";
import PDFDocument from "pdfkit";
import { appendAudit } from "../common/audit.js";

export interface ExportFilters {
  subjectUserId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ExportRow {
  id: string;
  measuredAt: Date;
  bacPromille: string;
  subjectEmail: string;
  operatorEmail: string;
  deviceSerial: string;
  origin: string;
  acknowledgedAt: Date | null;
}

export async function fetchExportRows(
  organizationId: string,
  filters: ExportFilters,
): Promise<{ rows: ExportRow[]; orgName: string }> {
  const limit = Math.min(Math.max(filters.limit ?? 1000, 1), 5000);
  const conds = [eq(bacReadings.organizationId, organizationId)];
  if (filters.subjectUserId) conds.push(eq(bacReadings.subjectUserId, filters.subjectUserId));
  if (filters.from) conds.push(gte(bacReadings.measuredAt, new Date(filters.from)));
  if (filters.to) conds.push(lte(bacReadings.measuredAt, new Date(filters.to)));
  const db = getDb(process.env.DATABASE_URL as string);
  const readings = await db
    .select()
    .from(bacReadings)
    .where(and(...conds))
    .orderBy(desc(bacReadings.measuredAt))
    .limit(limit);
  const members = await db
    .select({ userId: users.id, email: users.email })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.organizationId, organizationId));
  const emails = new Map(members.map((m) => [m.userId, m.email] as const));
  const orgs = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return {
    orgName: orgs[0]?.name ?? organizationId,
    rows: readings.map((r) => ({
      id: r.id,
      measuredAt: r.measuredAt,
      bacPromille: r.bacPromille,
      subjectEmail: emails.get(r.subjectUserId) ?? r.subjectUserId,
      operatorEmail: emails.get(r.operatorUserId) ?? r.operatorUserId,
      deviceSerial: r.deviceSerial,
      origin: r.origin,
      acknowledgedAt: r.acknowledgedAt,
    })),
  };
}

const HEADERS = ["id", "measured_at", "bac_promille", "subject_email", "operator_email", "device_serial", "origin", "acknowledged_at"];

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows: ExportRow[]): string {
  const lines = [HEADERS.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.measuredAt.toISOString(),
        r.bacPromille,
        r.subjectEmail,
        r.operatorEmail,
        r.deviceSerial,
        r.origin,
        r.acknowledgedAt ? r.acknowledgedAt.toISOString() : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function rowsToPdf(orgName: string, rows: ExportRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (e: Error) => reject(e));
    doc.fontSize(18).text("BAC readings", { underline: true });
    doc.fontSize(11).text(`Organization: ${orgName}`);
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.text(`Rows: ${rows.length}`);
    doc.moveDown();
    const cols = ["Measured", "BAC ‰", "Subject", "Device", "Origin"];
    const widths = [130, 60, 160, 90, 80];
    let y = doc.y;
    doc.fontSize(9);
    let x = doc.page.margins.left;
    cols.forEach((c, i) => {
      doc.text(c, x, y, { width: widths[i], continued: false });
      x += widths[i];
    });
    y += 14;
    for (const r of rows) {
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      const cells = [
        r.measuredAt.toISOString().slice(0, 16).replace("T", " "),
        Number(r.bacPromille).toFixed(3),
        r.subjectEmail.slice(0, 24),
        r.deviceSerial,
        r.origin,
      ];
      x = doc.page.margins.left;
      cells.forEach((c, i) => {
        doc.text(c, x, y, { width: widths[i], continued: false });
        x += widths[i];
      });
      y += 14;
    }
    doc.end();
  });
}

export async function recordExportAudit(
  organizationId: string,
  actorUserId: string,
  format: string,
  count: number,
): Promise<void> {
  const db = getDb(process.env.DATABASE_URL as string);
  await appendAudit(db, {
    organizationId,
    actorUserId,
    action: "export.created",
    entityType: "export",
    details: { format, count },
  });
}
