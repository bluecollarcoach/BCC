import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { GraduationCap, Plus, PlayCircle, CheckCircle2 } from "lucide-react";

export const metadata = { title: "Training" };

export default async function TrainingPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const [courses, myEnrollments] = await Promise.all([
    prisma.course.findMany({
      where: { orgId: session.user.orgId, published: true },
      include: {
        _count: { select: { lessons: true, enrollments: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.enrollment.findMany({
      where: { userId: session.user.id },
      include: { course: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Training"
        description="Customer-facing courses and internal playbooks."
        actions={
          <Button asChild>
            <Link href="/training/new">
              <Plus className="h-4 w-4" /> New course
            </Link>
          </Button>
        }
      />

      {myEnrollments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>In progress</CardTitle>
            <CardDescription>Pick up where you left off.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {myEnrollments.map((e) => (
              <Link
                key={e.id}
                href={`/training/${e.course.slug}`}
                className="rounded-lg border border-border bg-card/60 p-4 hover:border-gold/40"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{e.course.title}</h3>
                  {e.completed ? (
                    <Badge variant="success">
                      <CheckCircle2 className="h-3 w-3 mr-1 inline" /> Done
                    </Badge>
                  ) : (
                    <Badge>{e.progress}%</Badge>
                  )}
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-gold" style={{ width: `${e.progress}%` }} />
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Course catalog</CardTitle>
        </CardHeader>
        <CardContent>
          {courses.length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title="No courses yet"
              description="Author your first course — onboarding, sales playbook, safety, or a customer-facing service explainer."
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {courses.map((c) => (
                <Link
                  key={c.id}
                  href={`/training/${c.slug}`}
                  className="rounded-lg border border-border bg-card/60 overflow-hidden hover:border-gold/40 hover:shadow-glow transition group"
                >
                  <div className="h-32 bg-gradient-to-br from-gold/30 via-gold/5 to-ink-900 flex items-center justify-center">
                    <PlayCircle className="h-10 w-10 text-gold/80 group-hover:text-gold transition" />
                  </div>
                  <div className="p-4">
                    <h3 className="font-display text-lg">{c.title}</h3>
                    {c.summary && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{c.summary}</p>
                    )}
                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{c._count.lessons} lessons</span>
                      <span className="text-muted-foreground">{c._count.enrollments} enrolled</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
