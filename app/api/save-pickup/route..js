export async function POST(request) {
  try {
    const body = await request.json();

    const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

    console.log('SAVE PICKUP ROUTE HIT');
    console.log('GOOGLE_SHEETS_WEBHOOK_URL exists:', Boolean(webhookUrl));
    console.log('Payload:', body);

    if (!webhookUrl) {
      return Response.json(
        {
          ok: false,
          message: 'GOOGLE_SHEETS_WEBHOOK_URL is not configured in Vercel.',
        },
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

    console.log('Google status:', googleResponse.status);
    console.log('Google response:', text);

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}

    return Response.json(
      {
        ok: googleResponse.ok && parsed?.ok !== false,
        message: parsed?.message || text || 'No response from Google',
        googleStatus: googleResponse.status,
        googleResponseText: text,
      },
      { status: googleResponse.ok ? 200 : googleResponse.status }
    );
  } catch (error) {
    console.error('Route error:', error);

    return Response.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
