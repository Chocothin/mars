type Session = {
  id: string;
  duration: number;
  completedAt: string;
};

type CreateSessionInput = {
  duration?: unknown;
  completedAt?: unknown;
};

const sessions: Session[] = [];

export async function GET(): Promise<Response> {
  return Response.json(sessions);
}

export async function POST(request: Request): Promise<Response> {
  let payload: CreateSessionInput;

  try {
    payload = (await request.json()) as CreateSessionInput;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (typeof payload.duration !== 'number' || !Number.isFinite(payload.duration) || payload.duration <= 0) {
    return Response.json(
      { error: 'duration must be a positive number' },
      { status: 400 },
    );
  }

  if (payload.completedAt !== undefined && typeof payload.completedAt !== 'string') {
    return Response.json(
      { error: 'completedAt must be an ISO date string' },
      { status: 400 },
    );
  }

  const session: Session = {
    id: crypto.randomUUID(),
    duration: payload.duration,
    completedAt: payload.completedAt ?? new Date().toISOString(),
  };

  sessions.unshift(session);

  return Response.json(session, { status: 201 });
}

export function resetSessionsForTesting(): void {
  sessions.length = 0;
}
