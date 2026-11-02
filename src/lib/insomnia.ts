/** Insomnia v4 export generated from the api-v1 contract (same source as the OpenAPI spec and the Postman collection). */
import { RESOURCES, listOperations } from '../../supabase/functions/api-v1/contract';

export function buildInsomniaExport(baseUrl: string): Record<string, unknown> {
  const ws = 'wrk_vireek';
  const env = 'env_vireek';
  const resources: Record<string, unknown>[] = [
    {
      _id: ws,
      _type: 'workspace',
      name: 'Vireek API',
      description:
        'Generated from the Vireek API contract. Set api_key in the environment (vrk_test_… for synthetic data).',
      scope: 'collection',
    },
    {
      _id: env,
      _type: 'environment',
      parentId: ws,
      name: 'Base Environment',
      data: { base_url: baseUrl, api_key: '' },
    },
  ];
  for (const r of RESOURCES) {
    resources.push({
      _id: `fld_${r.name}`,
      _type: 'request_group',
      parentId: ws,
      name: r.tag,
      description: r.description,
    });
  }
  for (const op of listOperations()) {
    resources.push({
      _id: `req_${op.id}`,
      _type: 'request',
      parentId: `fld_${op.resource}`,
      name: op.id,
      description: `${op.description} Requires the ${op.scope} scope.`,
      method: op.method,
      url: `{{ _.base_url }}${op.path.replace(/:(\w+)/g, '{{ _.$1 }}')}`,
      parameters: op.hasId
        ? []
        : [
            { name: 'limit', value: '25' },
            { name: 'before', value: '', disabled: true },
          ],
      headers: [{ name: 'Accept', value: 'application/json' }],
      authentication: { type: 'bearer', token: '{{ _.api_key }}' },
    });
  }
  return { _type: 'export', __export_format: 4, __export_source: 'vireek.api-contract', resources };
}
