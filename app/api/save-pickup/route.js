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
      } catch {
        parsed = null;
      }
  
      if (!googleResponse.ok) {
        return Response.json(
          {
            ok: false,
            message:
              parsed?.message ||
              text ||
              `Google webhook failed with status ${googleResponse.status}.`,
          },
          { status: googleResponse.status }
        );
      }
  
      return Response.json(
        {
          ok: true,
          message: parsed?.message || 'Saved to Google Sheet',
        },
        { status: 200 }
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