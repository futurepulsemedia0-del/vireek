// src/lib/importPresets.ts
//
// Field definitions, platform presets (ServiceTitan / Jobber / Housecall Pro)
// and header auto-mapping for the import wizard. Presets are *hints*: they
// pre-fill the column mapping from the headers those platforms commonly
// export, and the user always confirms or corrects it in the mapping step —
// so an export format change never breaks an import.

export type ImportType = 'customers' | 'jobs';
export type ImportPresetId = 'service_titan' | 'jobber' | 'housecall_pro' | 'csv';
export type FieldMapping = Record<string, string>;

export interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  aliases: string[];
}

export const CUSTOMER_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Full name', hint: 'Or map First + Last name below', aliases: ['name', 'fullname', 'customername', 'clientname', 'displayname', 'contactname', 'customer'] },
  { key: 'first_name', label: 'First name', aliases: ['firstname', 'first', 'givenname', 'fname'] },
  { key: 'last_name', label: 'Last name', aliases: ['lastname', 'last', 'surname', 'familyname', 'lname'] },
  { key: 'company', label: 'Company', hint: 'Used as the name for business customers', aliases: ['company', 'companyname', 'businessname', 'business', 'organization', 'organisation'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobilephone', 'cell', 'cellphone', 'primaryphone', 'homephone', 'workphone', 'telephone', 'contactphone'] },
  { key: 'email', label: 'Email', aliases: ['email', 'emailaddress', 'primaryemail', 'e-mail', 'contactemail'] },
  { key: 'address', label: 'Street address', aliases: ['address', 'streetaddress', 'street', 'street1', 'address1', 'addressline1', 'serviceaddress', 'locationaddress', 'billingaddress', 'mailingaddress'] },
  { key: 'city', label: 'City', aliases: ['city', 'town', 'locality'] },
  { key: 'state', label: 'State / Province', aliases: ['state', 'province', 'stateprovince', 'region'] },
  { key: 'zip', label: 'ZIP / Postal code', aliases: ['zip', 'zipcode', 'postalcode', 'postcode', 'zippostalcode'] },
  { key: 'customer_type', label: 'Customer type', hint: 'Residential or commercial', aliases: ['customertype', 'type', 'clienttype', 'category', 'segment'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments', 'comment', 'memo', 'internalnotes', 'customernotes'] },
  { key: 'external_id', label: 'Customer ID in the old system', hint: 'Strongly recommended — makes re-imports safe', aliases: ['customerid', 'clientid', 'id', 'externalid', 'accountnumber', 'customernumber', 'customerno', 'accountid'] },
];

export const JOB_FIELDS: FieldDef[] = [
  { key: 'customer_name', label: 'Customer name', hint: 'Or map First + Last name below', aliases: ['customername', 'customer', 'clientname', 'client', 'name', 'fullname', 'contactname', 'displayname'] },
  { key: 'customer_first_name', label: 'Customer first name', aliases: ['customerfirstname', 'firstname', 'clientfirstname'] },
  { key: 'customer_last_name', label: 'Customer last name', aliases: ['customerlastname', 'lastname', 'clientlastname'] },
  { key: 'customer_phone', label: 'Customer phone', hint: 'Used to link the job to the customer', aliases: ['customerphone', 'phone', 'phonenumber', 'mobile', 'mobilenumber', 'clientphone', 'contactphone', 'cell'] },
  { key: 'customer_external_id', label: 'Customer ID in the old system', hint: 'Best way to link jobs to customers', aliases: ['customerid', 'clientid', 'customernumber', 'accountnumber', 'accountid'] },
  { key: 'service_type', label: 'Service / job type', aliases: ['servicetype', 'jobtype', 'service', 'jobtitle', 'title', 'category', 'worktype', 'jobdescription', 'description', 'summary', 'businessunit'] },
  { key: 'address', label: 'Service address', aliases: ['address', 'serviceaddress', 'jobaddress', 'locationaddress', 'location', 'streetaddress', 'street', 'street1', 'address1'] },
  { key: 'city', label: 'City', aliases: ['city', 'town'] },
  { key: 'state', label: 'State / Province', aliases: ['state', 'province', 'stateprovince'] },
  { key: 'zip', label: 'ZIP / Postal code', aliases: ['zip', 'zipcode', 'postalcode', 'postcode'] },
  { key: 'scheduled_datetime', label: 'Scheduled date & time', aliases: ['scheduleddatetime', 'scheduleddate', 'scheduledstart', 'scheduled', 'appointmentstart', 'startdate', 'start', 'visitdate', 'jobdate', 'date', 'completedon', 'completeddate', 'createddate'] },
  { key: 'job_status', label: 'Job status', aliases: ['jobstatus', 'status', 'workstatus', 'state'] },
  { key: 'invoice_amount', label: 'Invoice total', aliases: ['invoiceamount', 'invoicetotal', 'total', 'amount', 'jobtotal', 'revenue', 'price', 'subtotal', 'totalamount'] },
  { key: 'invoice_status', label: 'Invoice status', aliases: ['invoicestatus', 'paymentstatus', 'paid', 'billingstatus'] },
  { key: 'external_id', label: 'Job ID in the old system', hint: 'Strongly recommended — makes re-imports safe', aliases: ['jobid', 'jobnumber', 'job', 'jobno', 'workorder', 'workordernumber', 'externalid', 'id', 'ticketnumber', 'invoicenumber'] },
];

export function fieldsFor(type: ImportType): FieldDef[] {
  return type === 'customers' ? CUSTOMER_FIELDS : JOB_FIELDS;
}

/** The import can run when at least one of these identifies who the row is about. */
export const REQUIRED_ANY: Record<ImportType, { keys: string[]; message: string }> = {
  customers: { keys: ['name', 'first_name', 'last_name', 'company'], message: 'Map a name column (full name, first/last name or company).' },
  jobs: { keys: ['customer_name', 'customer_first_name', 'customer_last_name', 'customer_external_id'], message: 'Map a customer name column (or the customer ID).' },
};

export function isMappingComplete(type: ImportType, mapping: FieldMapping): boolean {
  return REQUIRED_ANY[type].keys.some((k) => Boolean(mapping[k]));
}

export interface ImportPreset {
  id: ImportPresetId;
  label: string;
  description: string;
  howToExport: Record<ImportType, string[]>;
  /** Headers this platform commonly uses, tried before the generic aliases. */
  aliases: Partial<Record<ImportType, Record<string, string[]>>>;
  /** Normalized headers distinctive enough to suggest this preset from a file. */
  signature: string[];
}

const TIP = 'Keep the ID column in the export — it lets Vireek recognize the same record next time, so re-importing never creates duplicates.';

export const PRESETS: ImportPreset[] = [
  {
    id: 'service_titan',
    label: 'ServiceTitan',
    description: 'Customer and job reports exported to Excel or CSV.',
    howToExport: {
      customers: ['In ServiceTitan, run a Customers report (or open the Customers list).', 'Export it to Excel or CSV.', TIP],
      jobs: ['In ServiceTitan, run a Jobs / Job History report for the date range you want.', 'Export it to Excel or CSV.', TIP],
    },
    aliases: {
      customers: { name: ['customername', 'name'], external_id: ['customerid', 'id'], customer_type: ['type', 'customertype'], phone: ['phonenumber', 'mobilephone', 'phone'], address: ['streetaddress', 'street', 'address'], zip: ['zip', 'postalcode'] },
      jobs: { customer_name: ['customername', 'customer'], customer_external_id: ['customerid'], external_id: ['jobnumber', 'job', 'jobid'], service_type: ['jobtype', 'businessunit', 'summary'], job_status: ['jobstatus', 'status'], scheduled_datetime: ['scheduleddate', 'scheduled', 'appointmentstart', 'start', 'completiondate', 'completedon'], invoice_amount: ['invoicetotal', 'total', 'jobtotal'], address: ['locationaddress', 'jobaddress', 'address'] },
    },
    signature: ['businessunit', 'jobtype', 'jobnumber', 'customerid', 'completedon', 'appointmentstart', 'invoicetotal'],
  },
  {
    id: 'jobber',
    label: 'Jobber',
    description: 'Client and job exports from Jobber.',
    howToExport: {
      customers: ['In Jobber, open Clients and choose Export (or use the data export under Settings).', 'Download the CSV.', TIP],
      jobs: ['In Jobber, open Reports → Jobs (or Visits) and export the CSV for the date range you want.', TIP],
    },
    aliases: {
      customers: { first_name: ['firstname'], last_name: ['lastname'], company: ['businessname', 'companyname', 'company'], phone: ['phonenumber', 'mainphones', 'phone'], email: ['emailaddress', 'mainemails', 'email'], address: ['street1', 'billingstreet1', 'streetaddress', 'address'], city: ['city', 'billingcity'], state: ['stateprovince', 'state', 'billingprovince'], zip: ['zippostalcode', 'zipcode', 'billingzip'], external_id: ['clientid', 'id'] },
      jobs: { customer_name: ['clientname', 'client', 'customername'], customer_external_id: ['clientid'], external_id: ['job', 'jobid', 'jobnumber'], service_type: ['jobtitle', 'title', 'servicetype'], job_status: ['status', 'jobstatus'], scheduled_datetime: ['startdate', 'visitdate', 'scheduled', 'start'], invoice_amount: ['total', 'jobtotal', 'invoicetotal'], address: ['servicestreet1', 'propertyaddress', 'address'] },
    },
    signature: ['clienttags', 'businessname', 'leadsource', 'street1', 'zippostalcode', 'stateprovince', 'jobtitle'],
  },
  {
    id: 'housecall_pro',
    label: 'Housecall Pro',
    description: 'Customer and job exports from Housecall Pro.',
    howToExport: {
      customers: ['In Housecall Pro, open Customers and use the export option.', 'Download the CSV.', TIP],
      jobs: ['In Housecall Pro, open Reports (or Jobs) and export the job list for the date range you want.', TIP],
    },
    aliases: {
      customers: { first_name: ['firstname'], last_name: ['lastname'], company: ['company', 'companyname'], phone: ['mobilenumber', 'mobilephone', 'homenumber', 'phone'], email: ['email'], address: ['streetaddress', 'address', 'street'], customer_type: ['customertype', 'type'], notes: ['notes', 'customernotes'], external_id: ['customerid', 'id'] },
      jobs: { customer_name: ['customername', 'customer'], customer_external_id: ['customerid'], external_id: ['jobnumber', 'jobid', 'job'], service_type: ['jobtype', 'jobdescription', 'description', 'service'], job_status: ['jobstatus', 'status'], scheduled_datetime: ['scheduledstart', 'scheduleddate', 'scheduled', 'start'], invoice_amount: ['invoiceamount', 'total', 'jobtotal', 'amount'], address: ['serviceaddress', 'address', 'street'] },
    },
    signature: ['mobilenumber', 'homenumber', 'worknumber', 'scheduledstart', 'customertype', 'jobdescription', 'customernotes'],
  },
  {
    id: 'csv',
    label: 'Other CSV / Excel',
    description: 'Any spreadsheet — FieldEdge, Service Fusion, QuickBooks, or your own.',
    howToExport: {
      customers: ['One row per customer, with a header row.', 'A customer ID column is recommended but not required.'],
      jobs: ['One row per job, with a header row.', 'A job ID column is recommended — without one, jobs are matched on customer + date + service + amount.'],
    },
    aliases: {},
    signature: [],
  },
];

export const PRESET_BY_ID: Record<ImportPresetId, ImportPreset> = Object.fromEntries(PRESETS.map((p) => [p.id, p])) as Record<ImportPresetId, ImportPreset>;

export const normalizeHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Suggests a preset from the file's headers (needs ≥2 distinctive hits). Never forced on the user. */
export function detectPreset(headers: string[]): ImportPresetId | null {
  const normalized = new Set(headers.map(normalizeHeader));
  let best: { id: ImportPresetId; hits: number } | null = null;
  for (const preset of PRESETS) {
    const hits = preset.signature.filter((s) => normalized.has(s)).length;
    if (hits >= 2 && (!best || hits > best.hits)) best = { id: preset.id, hits };
  }
  return best?.id ?? null;
}

export interface AutoMapResult {
  mapping: FieldMapping;
  /** fields that were filled automatically (shown with an "Auto" badge) */
  auto: string[];
}

/**
 * Pass 1 claims exact header matches (preset aliases first, then generic);
 * pass 2 fills what's left with "contains" matches on longer aliases only, so
 * "First name" is never mistaken for "Full name".
 */
export function autoMap(headers: string[], type: ImportType, presetId: ImportPresetId): AutoMapResult {
  const fields = fieldsFor(type);
  const presetAliases = PRESET_BY_ID[presetId].aliases[type] ?? {};
  const normalized = headers.map((h) => ({ header: h, norm: normalizeHeader(h) }));
  const used = new Set<string>();
  const mapping: FieldMapping = {};

  const claim = (field: FieldDef, test: (norm: string, alias: string) => boolean, aliases: string[]) => {
    for (const alias of aliases) {
      const hit = normalized.find((h) => !used.has(h.header) && h.norm && test(h.norm, alias));
      if (hit) {
        mapping[field.key] = hit.header;
        used.add(hit.header);
        return true;
      }
    }
    return false;
  };

  for (const field of fields) {
    const aliases = [...(presetAliases[field.key] ?? []), ...field.aliases];
    claim(field, (n, a) => n === a, aliases);
  }
  for (const field of fields) {
    if (mapping[field.key]) continue;
    const aliases = [...(presetAliases[field.key] ?? []), ...field.aliases].filter((a) => a.length >= 6);
    claim(field, (n, a) => n.includes(a), aliases);
  }
  return { mapping, auto: Object.keys(mapping) };
}
