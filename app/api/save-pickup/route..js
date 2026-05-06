export async function POST(request) {
  try {
    const body = await request.json();
    const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

    if (!webhookUrl) {
      return Response.json(
        { ok: false, message: 'GOOGLE_SHEETS_WEBHOOK_URL is not configured.' },
        { status: 500 }
      );
    }

    const googleResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(body),
      redirect: 'follow',
      cache: 'no-store',
    });

    const text = await googleResponse.text();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}

    return Response.json(
      {
        ok: googleResponse.ok && parsed?.ok !== false,
        message: parsed?.message || text || 'Saved to Google Sheet',
      },
      { status: googleResponse.ok ? 200 : googleResponse.status }
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}