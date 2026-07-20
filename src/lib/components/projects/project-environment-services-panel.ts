import type { ProjectEnvVar } from '@prisma/client';
import type {
	EnvironmentServiceOutputSummary,
	EnvironmentServiceSourceFieldSummary,
	EnvironmentServiceSummary,
	PrepareEvent
} from './environment-setup-state';
import { eventLabel } from './environment-setup-state';

export type EditableMapping = Pick<ProjectEnvVar, 'key' | 'enabled'> & {
	template: string;
	sensitive: 'auto' | ProjectEnvVar['sensitive'];
};

type DraftMappings = Record<string, EditableMapping[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serviceLabel(service: EnvironmentServiceSummary): string {
	return service.name ?? service.kind ?? 'service';
}

export function outputsFor(service: EnvironmentServiceSummary): EnvironmentServiceOutputSummary[] {
	return Array.isArray(service.outputs)
		? service.outputs.filter(
				(output): output is EnvironmentServiceOutputSummary =>
					!!output && typeof output === 'object' && typeof output.key === 'string'
			)
		: [];
}

export function sourceFieldsFor(
	service: EnvironmentServiceSummary
): EnvironmentServiceSourceFieldSummary[] {
	return Array.isArray(service.sourceFields)
		? service.sourceFields.filter(
				(field): field is EnvironmentServiceSourceFieldSummary =>
					!!field && typeof field === 'object' && typeof field.key === 'string'
			)
		: [];
}

export function sourceFieldValue(field: EnvironmentServiceSourceFieldSummary): string {
	if (field.sensitive) return 'masked';
	if (typeof field.value === 'string' && field.value.length > 0) return field.value;
	return field.hasValue ? 'set' : 'missing';
}

export function messagesFor(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(message): message is string => typeof message === 'string' && message.length > 0
	);
}

export function eventLinesFor(
	service: EnvironmentServiceSummary,
	serviceEvents: (serviceId: string) => PrepareEvent[]
): Array<PrepareEvent & { label: string }> {
	if (!service.id) return [];
	return serviceEvents(service.id)
		.map((event) => ({ ...event, label: eventLabel(event) }))
		.filter((event) => event.label.length > 0);
}

export function serviceMappingsFor(service: EnvironmentServiceSummary): EditableMapping[] {
	if (!Array.isArray(service.envMappings)) return [];
	return service.envMappings
		.filter(
			(mapping): mapping is EditableMapping =>
				isRecord(mapping) && typeof mapping.key === 'string' && typeof mapping.template === 'string'
		)
		.map((mapping) => ({
			key: mapping.key,
			template: mapping.template,
			enabled: mapping.enabled !== false,
			sensitive:
				mapping.sensitive === true || mapping.sensitive === false ? mapping.sensitive : 'auto'
		}));
}

function mappingEquals(left: EditableMapping, right: EditableMapping): boolean {
	return (
		left.key === right.key &&
		left.template === right.template &&
		left.enabled === right.enabled &&
		left.sensitive === right.sensitive
	);
}

function mappingsEqual(left: EditableMapping[], right: EditableMapping[]): boolean {
	return (
		left.length === right.length &&
		left.every((mapping, index) => mappingEquals(mapping, right[index]))
	);
}

export function mappingsFor(
	service: EnvironmentServiceSummary,
	drafts: DraftMappings
): EditableMapping[] {
	const serviceMappings = serviceMappingsFor(service);
	if (!service.id || !drafts[service.id]) return serviceMappings;
	const draft = drafts[service.id];
	return mappingsEqual(draft, serviceMappings) ? serviceMappings : draft;
}

export function sensitiveModeValue(mapping: EditableMapping): 'auto' | 'true' | 'false' {
	if (mapping.sensitive === true) return 'true';
	if (mapping.sensitive === false) return 'false';
	return 'auto';
}

export function sensitiveModeLabel(value: 'auto' | 'true' | 'false'): string {
	if (value === 'true') return 'Sensitive';
	if (value === 'false') return 'Not sensitive';
	return 'Auto sensitivity';
}

export function sensitiveValueFromMode(value: string | undefined): EditableMapping['sensitive'] {
	return value === 'true' ? true : value === 'false' ? false : 'auto';
}

export function outputValue(output: EnvironmentServiceOutputSummary): string {
	if (output.sensitive) return 'masked';
	return output.value ?? '';
}

export function statusVariant(status: string | null | undefined) {
	if (status === 'failed') return 'destructive';
	if (status === 'ready') return 'secondary';
	return 'outline';
}
