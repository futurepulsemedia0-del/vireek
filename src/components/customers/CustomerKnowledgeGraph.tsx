import { Network, Wrench, BriefcaseBusiness, Phone, User } from 'lucide-react';

export interface GraphEquipment {
  id: string;
  label: string;
  status?: string | null;
}

export interface GraphJob {
  id: string;
  label: string;
  status?: string | null;
}

export interface GraphCall {
  id: string;
  label: string;
}

export interface GraphLink {
  equipment_id: string;
  job_id: string;
  service_type?: string | null;
}

interface CustomerKnowledgeGraphProps {
  customer: {
    id: string;
    name: string;
  };
  equipment: GraphEquipment[];
  jobs: GraphJob[];
  calls: GraphCall[];
  links: GraphLink[];
}

export function CustomerKnowledgeGraph({
  customer,
  equipment,
  jobs,
  calls,
  links,
}: CustomerKnowledgeGraphProps) {
  const equipmentById = new Map(equipment.map((item) => [item.id, item]));

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Network size={16} />
        </div>

        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">
            Customer knowledge graph
          </p>
          <p className="truncate text-xs text-text-secondary">
            Relationships and activity for {customer.name}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-bg-secondary p-3">
          <div className="mb-2 flex items-center gap-2 text-text-secondary">
            <User size={14} />
            <span className="text-xs font-medium">Customer</span>
          </div>
          <p className="truncate text-sm font-medium text-text-primary">
            {customer.name}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-bg-secondary p-3">
          <div className="mb-2 flex items-center gap-2 text-text-secondary">
            <Wrench size={14} />
            <span className="text-xs font-medium">Equipment</span>
          </div>
          <p className="text-lg font-semibold text-text-primary">
            {equipment.length}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-bg-secondary p-3">
          <div className="mb-2 flex items-center gap-2 text-text-secondary">
            <BriefcaseBusiness size={14} />
            <span className="text-xs font-medium">Jobs</span>
          </div>
          <p className="text-lg font-semibold text-text-primary">
            {jobs.length}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-bg-secondary p-3">
          <div className="mb-2 flex items-center gap-2 text-text-secondary">
            <Phone size={14} />
            <span className="text-xs font-medium">Calls</span>
          </div>
          <p className="text-lg font-semibold text-text-primary">
            {calls.length}
          </p>
        </div>
      </div>

      {equipment.length === 0 && jobs.length === 0 && calls.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border bg-bg-secondary p-5 text-center">
          <p className="text-sm font-medium text-text-primary">
            No relationship data yet
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            Equipment, jobs, and calls will appear here when available.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {equipment.map((item) => {
            const linkedJobs = links
              .filter((link) => link.equipment_id === item.id)
              .map((link) => ({
                link,
                job: jobs.find((job) => job.id === link.job_id),
              }))
              .filter(
                (
                  item,
                ): item is {
                  link: GraphLink;
                  job: GraphJob;
                } => Boolean(item.job),
              );

            return (
              <div
                key={item.id}
                className="rounded-lg border border-border bg-bg-secondary p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Wrench size={14} className="shrink-0 text-accent" />
                    <span className="truncate text-sm font-medium text-text-primary">
                      {item.label}
                    </span>
                  </div>

                  {item.status && (
                    <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium capitalize text-text-secondary">
                      {item.status}
                    </span>
                  )}
                </div>

                {linkedJobs.length > 0 && (
                  <div className="mt-2 space-y-1.5 border-l border-border pl-4">
                    {linkedJobs.map(({ link, job }) => (
                      <div
                        key={`${item.id}-${job.id}`}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <BriefcaseBusiness
                            size={12}
                            className="shrink-0 text-text-secondary"
                          />
                          <span className="truncate text-text-secondary">
                            {job.label}
                          </span>
                        </div>

                        {link.service_type && (
                          <span className="shrink-0 text-text-secondary">
                            {link.service_type}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {jobs.length > 0 && equipment.length === 0 && (
            <div className="rounded-lg border border-border bg-bg-secondary p-3">
              <div className="mb-2 flex items-center gap-2">
                <BriefcaseBusiness size={14} className="text-accent" />
                <span className="text-xs font-medium text-text-secondary">
                  Jobs
                </span>
              </div>

              <div className="space-y-2">
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary px-3 py-2"
                  >
                    <span className="truncate text-sm text-text-primary">
                      {job.label}
                    </span>

                    {job.status && (
                      <span className="shrink-0 text-xs text-text-secondary">
                        {job.status}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {calls.length > 0 && (
            <div className="rounded-lg border border-border bg-bg-secondary p-3">
              <div className="mb-2 flex items-center gap-2">
                <Phone size={14} className="text-accent" />
                <span className="text-xs font-medium text-text-secondary">
                  Recent calls
                </span>
              </div>

              <div className="space-y-1.5">
                {calls.map((call) => (
                  <div
                    key={call.id}
                    className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  >
                    {call.label}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-text-secondary">
        {equipmentById.size} equipment node{equipmentById.size === 1 ? '' : 's'}{' '}
        · {jobs.length} job node{jobs.length === 1 ? '' : 's'} ·{' '}
        {calls.length} call node{calls.length === 1 ? '' : 's'}
      </p>
    </div>
  );
}
