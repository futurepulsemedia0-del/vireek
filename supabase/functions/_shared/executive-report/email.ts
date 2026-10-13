// supabase/functions/_shared/executive-report/email.ts
// Resend sender with a PDF attachment. (The shared sendEmail() has no
// attachment support, so this is intentionally separate.)

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export async function sendReportEmail(opts: {
  to: string; subject: string; html: string; text: string; filename: string; pdf: Uint8Array;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  if (!apiKey) return { ok: false, error: "Email isn't configured yet (missing RESEND_API_KEY)." };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text,
        attachments: [{ filename: opts.filename, content: toBase64(opts.pdf) }],
      }),
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
