// src/lib/native/nfc.ts
// Native NFC tag reading for iOS (Core NFC) and Android. Web NFC does not exist inside
// WebViews, so the installed app reads tags through a native plugin.
// iOS session type: 'ndef' covers programmed tags. To also read raw UID-only tags, switch
// IOS_SESSION to 'tag' AND add the "TAG" format to the NFC entitlement (see setup guide).

import type { NdefRecord } from '@capgo/capacitor-nfc';

const IOS_SESSION: 'ndef' | 'tag' = 'ndef';

const URI_PREFIX = [
  '', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:', 'ftp://anonymous:anonymous@',
  'ftp://ftp.', 'ftps://', 'sftp://', 'smb://', 'nfs://', 'ftp://', 'dav://', 'news:', 'telnet://', 'imap:',
  'rtsp://', 'urn:', 'pop:', 'sip:', 'sips:', 'tftp:', 'btspp://', 'btl2cap://', 'btgoep://', 'tcpobex://',
  'irdaobex://', 'file://', 'urn:epc:id:', 'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:', 'urn:nfc:',
];

export function bytesToHex(bytes: number[] | undefined): string {
  return (bytes ?? []).map((b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/** Decodes the text / URL records of an NDEF message; other record types are ignored. */
export function decodeNdefRecord(record: Pick<NdefRecord, 'type' | 'payload'>): string | null {
  const type = String.fromCharCode(...(record.type ?? []));
  const payload = record.payload ?? [];
  const decoder = new TextDecoder();
  if (type === 'T' && payload.length > 0) {
    const langLength = payload[0] & 0x3f;
    return decoder.decode(new Uint8Array(payload.slice(1 + langLength)));
  }
  if (type === 'U' && payload.length > 0) {
    return (URI_PREFIX[payload[0]] ?? '') + decoder.decode(new Uint8Array(payload.slice(1)));
  }
  return null;
}

export async function isNativeNfcSupported(): Promise<boolean> {
  const { CapacitorNfc } = await import('@capgo/capacitor-nfc');
  const { supported } = await CapacitorNfc.isSupported();
  if (!supported) return false;
  const { status } = await CapacitorNfc.getStatus();
  return status !== 'NO_NFC';
}

export async function readNativeNfcTag(signal: AbortSignal): Promise<{ serial: string; records: string[] }> {
  const { CapacitorNfc } = await import('@capgo/capacitor-nfc');
  const { status } = await CapacitorNfc.getStatus();
  if (status === 'NFC_DISABLED') {
    await CapacitorNfc.showSettings().catch(() => undefined);
    throw new Error('NFC is turned off. Enable it in Settings and try again.');
  }

  return new Promise((resolve, reject) => {
    const handles: Array<Promise<{ remove: () => Promise<void> }>> = [];
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      handles.forEach((h) => void h.then((x) => x.remove()).catch(() => undefined));
      void CapacitorNfc.stopScanning().catch(() => undefined);
      action();
    };

    handles.push(
      CapacitorNfc.addListener('nfcEvent', (event) => {
        const tag = event.tag;
        if (!tag) return;
        const records = (tag.ndefMessage ?? []).map(decodeNdefRecord).filter((r): r is string => r !== null);
        finish(() => resolve({ serial: bytesToHex(tag.id), records }));
      }),
      CapacitorNfc.addListener('nfcSessionEnd', ({ reason }) => {
        finish(() =>
          reason === 'userCancelled'
            ? reject(new DOMException('Scan cancelled', 'AbortError'))
            : reject(new Error(reason === 'sessionTimeout' ? 'No tag detected.' : 'The NFC session failed.')),
        );
      }),
    );

    signal.addEventListener('abort', () => finish(() => reject(new DOMException('Scan cancelled', 'AbortError'))), { once: true });

    CapacitorNfc.startScanning({
      invalidateAfterFirstRead: true,
      alertMessage: 'Hold the top of your phone near the tag.',
      iosSessionType: IOS_SESSION,
    }).catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error('Could not start NFC.'))));
  });
}
