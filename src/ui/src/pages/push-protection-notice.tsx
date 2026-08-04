import type { ReapCompletedPayload } from "@/api/types.ts";

type PushProtectionDetail = NonNullable<ReapCompletedPayload["pushProtection"]>;

export function PushProtectionNotice({ detail }: { detail: PushProtectionDetail }) {
	return (
		<div className="rounded-md border border-(--color-destructive) p-3 text-sm">
			<div className="font-medium">GitHub push protection blocked this run</div>
			{detail.locations.length > 0 ? (
				<ul className="mt-1 list-disc pl-5 font-mono text-xs">
					{detail.locations.map((location) => (
						<li key={location}>{location}</li>
					))}
				</ul>
			) : null}
			{detail.unblockUrl ? (
				<a
					className="mt-2 inline-block underline"
					href={detail.unblockUrl}
					target="_blank"
					rel="noreferrer noopener"
				>
					Review GitHub’s unblock page ↗
				</a>
			) : null}
		</div>
	);
}
