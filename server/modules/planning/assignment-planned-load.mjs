import {compareHours, decimalQuantity, formatQuantity} from '../../../shared/work-hours.mjs';
import {validCapacityRange} from '../../../shared/worker-capacity.mjs';
import {calculateScopedCapacity, capacityFailure} from './worker-capacity-service.mjs';

export async function assignmentPlannedPercentage(client, req, employeeId, definition, buildEmployeeScopeWhere) {
  if (definition.quantityUnit === 'percentage') return definition.quantityExact;
  const {startsOn, endsOn, quantityExact} = definition;
  if (!validCapacityRange(startsOn, endsOn)) {
    capacityFailure('ASSIGNMENT_CAPACITY_RANGE', 'Choose a supported assignment capacity range.');
  }
  const capacity = await calculateScopedCapacity(client, req, employeeId, startsOn, endsOn, buildEmployeeScopeWhere);
  const available = capacity.result.totals.availableHoursExact;
  if (available === null || (available === '0' && quantityExact !== '0')) {
    capacityFailure('ASSIGNMENT_CAPACITY_UNAVAILABLE', 'Available hours are required for the assignment dates.');
  }
  if (quantityExact === '0') return '0';

  // Ceiling protects percentage-based overlap limits at the twelfth decimal place.
  const hours = decimalQuantity(quantityExact);
  const weight = decimalQuantity(available);
  const numerator = hours.units * 100n * 10n ** BigInt(weight.scale + 12);
  const denominator = weight.units * 10n ** BigInt(hours.scale);
  const percentage = formatQuantity({units:(numerator + denominator - 1n) / denominator, scale:12});
  if (compareHours(percentage, '200') > 0) {
    capacityFailure('ASSIGNMENT_PERCENTAGE_LIMIT', 'Planned hours exceed the supported 200% assignment limit.');
  }
  return percentage;
}
