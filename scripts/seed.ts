/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱  Seeding Blue Collar Coach Connect…");

  // ----------------- Org -----------------
  const org = await prisma.org.upsert({
    where: { slug: "demo-shop" },
    update: {},
    create: {
      name: "Castro Mechanical",
      slug: "demo-shop",
      industry: "HVAC & Plumbing",
      size: "12 employees",
    },
  });

  // ----------------- Users -----------------
  const owner = await prisma.user.upsert({
    where: { email: "owner@bluecollarcoach.us" },
    update: { orgId: org.id, role: "OWNER" },
    create: {
      email: "owner@bluecollarcoach.us",
      name: "Mike Castro",
      role: "OWNER",
      orgId: org.id,
      title: "Owner",
      hourlyRate: 12500,
    },
  });
  const coach = await prisma.user.upsert({
    where: { email: "coach@bluecollarcoach.us" },
    update: { orgId: org.id, role: "COACH" },
    create: {
      email: "coach@bluecollarcoach.us",
      name: "BCC Coach",
      role: "COACH",
      orgId: org.id,
      title: "Business Coach",
    },
  });
  const crew = await Promise.all(
    [
      { name: "Diego Reyes",  email: "diego@castromech.example" },
      { name: "Tasha Morgan", email: "tasha@castromech.example" },
      { name: "Will Petty",   email: "will@castromech.example" },
      { name: "Marcus Bell",  email: "marcus@castromech.example" },
    ].map((u) =>
      prisma.user.upsert({
        where: { email: u.email },
        update: { orgId: org.id, role: "STAFF" },
        create: { ...u, role: "STAFF", orgId: org.id, hourlyRate: 4500 + Math.floor(Math.random() * 1500) },
      }),
    ),
  );

  // ----------------- Pipeline + stages -----------------
  let pipeline = await prisma.pipeline.findFirst({
    where: { orgId: org.id, isDefault: true },
  });
  if (!pipeline) {
    pipeline = await prisma.pipeline.create({
      data: {
        orgId: org.id,
        name: "Service Sales",
        isDefault: true,
      },
    });
    await prisma.pipelineStage.createMany({
      data: [
        { pipelineId: pipeline.id, name: "Lead",        order: 1, probability: 10 },
        { pipelineId: pipeline.id, name: "Qualified",   order: 2, probability: 25 },
        { pipelineId: pipeline.id, name: "Proposal",    order: 3, probability: 50 },
        { pipelineId: pipeline.id, name: "Negotiation", order: 4, probability: 75 },
        { pipelineId: pipeline.id, name: "Won",         order: 5, probability: 100 },
      ],
    });
  }
  const stages = await prisma.pipelineStage.findMany({
    where: { pipelineId: pipeline.id },
    orderBy: { order: "asc" },
  });

  // ----------------- Companies & contacts -----------------
  const henley = await prisma.company.upsert({
    where: { id: "seed-henley" },
    update: {},
    create: {
      id: "seed-henley",
      orgId: org.id,
      name: "Henley Apartments",
      industry: "Residential property mgmt",
    },
  });

  const contactSamples = [
    { firstName: "Sarah",  lastName: "Henley", email: "sarah@henleyapts.example", stage: "QUALIFIED" as const, companyId: henley.id, title: "Owner" },
    { firstName: "Jordan", lastName: "Park",   email: "jordan@parkindustries.example", stage: "CUSTOMER" as const,  title: "Facilities Mgr" },
    { firstName: "Ravi",   lastName: "Patel",  email: "ravi@patelfoods.example",       stage: "LEAD" as const,      title: "Owner" },
    { firstName: "Aimee",  lastName: "Chen",   email: "aimee@chendental.example",      stage: "CUSTOMER" as const,  title: "Practice Mgr" },
    { firstName: "Carlos", lastName: "Vega",   email: "carlos@vegaproperty.example",   stage: "QUALIFIED" as const, title: "Owner" },
  ];
  for (const c of contactSamples) {
    await prisma.contact.upsert({
      where: { id: `seed-${c.email}` },
      update: {},
      create: { id: `seed-${c.email}`, orgId: org.id, ownerId: owner.id, ...c },
    });
  }
  const contacts = await prisma.contact.findMany({ where: { orgId: org.id } });

  // ----------------- Deals -----------------
  const dealSamples = [
    { name: "Henley HVAC retrofit",   amount: 48_000, stageIdx: 2, contactIdx: 0 },
    { name: "Park HQ — annual contract", amount: 36_000, stageIdx: 1, contactIdx: 1 },
    { name: "Vega 4-plex install",    amount: 22_500, stageIdx: 3, contactIdx: 4 },
    { name: "Chen Dental — chiller",  amount: 18_900, stageIdx: 4, contactIdx: 3 },
    { name: "Patel Foods — walk-in",  amount: 31_200, stageIdx: 0, contactIdx: 2 },
  ];
  for (const d of dealSamples) {
    await prisma.deal.upsert({
      where: { id: `seed-deal-${d.name}` },
      update: {},
      create: {
        id: `seed-deal-${d.name}`,
        orgId: org.id,
        name: d.name,
        amountCents: d.amount * 100,
        pipelineId: pipeline.id,
        stageId: stages[d.stageIdx].id,
        status: d.stageIdx === 4 ? "WON" : "OPEN",
        closedAt: d.stageIdx === 4 ? new Date() : null,
        contactId: contacts[d.contactIdx]?.id,
        ownerId: owner.id,
      },
    });
  }

  // ----------------- Chat channels -----------------
  const channels = [
    { name: "announcements", topic: "Pinned messages for everyone." },
    { name: "install-crew",  topic: "Daily crew comms." },
    { name: "office",        topic: "Bookkeeping + scheduling." },
    { name: "coaching",      topic: "1:1 with the BCC coach." },
  ];
  for (const c of channels) {
    const existing = await prisma.chatChannel.findFirst({
      where: { orgId: org.id, name: c.name },
    });
    const channel = existing ?? (await prisma.chatChannel.create({
      data: { orgId: org.id, name: c.name, topic: c.topic, kind: "PUBLIC" },
    }));
    // Add all users as members of public channels
    const all = [owner, coach, ...crew];
    for (const u of all) {
      await prisma.channelMember.upsert({
        where: { channelId_userId: { channelId: channel.id, userId: u.id } },
        update: {},
        create: { channelId: channel.id, userId: u.id },
      });
    }
    // Add a welcome message
    const hasMsg = await prisma.chatMessage.findFirst({ where: { channelId: channel.id } });
    if (!hasMsg) {
      await prisma.chatMessage.create({
        data: {
          channelId: channel.id,
          authorId: coach.id,
          body:
            c.name === "announcements"
              ? "Welcome to BCC Connect 🛠️ — your one place for crew comms, customers, and books."
              : `Welcome to #${c.name}.`,
        },
      });
    }
  }

  // ----------------- Time entries -----------------
  for (let day = 1; day <= 5; day++) {
    for (const u of crew) {
      const start = new Date();
      start.setDate(start.getDate() - day);
      start.setHours(8, 0, 0, 0);
      const end = new Date(start);
      end.setHours(start.getHours() + 7 + Math.floor(Math.random() * 2));
      await prisma.timeEntry.create({
        data: {
          orgId: org.id,
          userId: u.id,
          jobName: ["Henley HVAC", "Park HQ", "Vega 4-plex"][day % 3],
          startedAt: start,
          endedAt: end,
          durationSec: Math.floor((end.getTime() - start.getTime()) / 1000),
          status: "APPROVED",
          billable: true,
          rateCents: u.hourlyRate,
        },
      });
    }
  }

  // ----------------- Calendar event -----------------
  await prisma.calendarEvent.create({
    data: {
      orgId: org.id,
      ownerId: owner.id,
      title: "Coaching call — Mike + BCC",
      startAt: new Date(new Date().setHours(14, 0, 0, 0)),
      endAt: new Date(new Date().setHours(15, 0, 0, 0)),
      source: "LOCAL",
    },
  });

  // ----------------- Financial periods -----------------
  for (let i = 0; i < 6; i++) {
    const end = new Date();
    end.setMonth(end.getMonth() - i);
    end.setDate(0);
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    const revenue = (90_000 + (5 - i) * 8_000 + Math.floor(Math.random() * 20_000)) * 100;
    const cogs = Math.floor(revenue * 0.42);
    const gm = revenue - cogs;
    const exp = Math.floor(revenue * 0.31);
    await prisma.financialPeriod.upsert({
      where: { orgId_periodStart_periodEnd: { orgId: org.id, periodStart: start, periodEnd: end } },
      update: {},
      create: {
        orgId: org.id,
        periodStart: start,
        periodEnd: end,
        revenueCents: revenue,
        cogsCents: cogs,
        grossMarginCents: gm,
        expensesCents: exp,
        netIncomeCents: gm - exp,
        cashCents: 80_000_00 + Math.floor(Math.random() * 30_000_00),
        arCents: 25_000_00 + Math.floor(Math.random() * 15_000_00),
        apCents: 18_000_00 + Math.floor(Math.random() * 8_000_00),
        source: "SEED",
      },
    });
  }

  // ----------------- Course -----------------
  await prisma.course.upsert({
    where: { orgId_slug: { orgId: org.id, slug: "first-call-mastery" } },
    update: {},
    create: {
      orgId: org.id,
      slug: "first-call-mastery",
      title: "First-Call Mastery",
      summary: "Turn cold calls into booked jobs — a 6-lesson playbook for your CSRs.",
      published: true,
    },
  });

  console.log("✅  Seed complete.");
  console.log(`   Owner: ${owner.email}`);
  console.log(`   Org:   ${org.name} (${org.slug})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
