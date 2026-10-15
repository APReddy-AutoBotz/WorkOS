/** Validate an Employee Master operation without changing business records. */
export const validateEmployeeImportDryRun = async ({
  client,
  rows,
  rowNumbers,
  duplicateRowNumbers,
  duplicateErrors,
  scope,
  assertMayExit,
  assertMayReactivate,
}) => {
  const errors = [...duplicateErrors];
  const invalidSubmittedRows = new Set(duplicateRowNumbers);
  const directorResult = await client.query('select id from country_directors');
  const directorIds = new Set(directorResult.rows.map(row => row.id));
  const employeeState = await client.query(`
    select id, employee_id, status, reporting_manager_id
    from employees
    where organization_id=$1 and legal_entity_id=$2
  `, [scope.organizationId, scope.legalEntityId]);
  const simulatedEmployeesById = new Map(employeeState.rows.map(employee => [String(employee.id), {...employee, id: String(employee.id)}]));
  const simulatedEmployeesByCode = new Map(employeeState.rows.map(employee => [String(employee.employee_id), {...employee, id: String(employee.id)}]));

  const createsReportingCycle = (managerId, employeeId) => {
    let nextManagerId = managerId == null ? null : String(managerId);
    const visited = new Set();
    while (nextManagerId) {
      if (nextManagerId === String(employeeId) || visited.has(nextManagerId)) return true;
      visited.add(nextManagerId);
      nextManagerId = simulatedEmployeesById.get(nextManagerId)?.reporting_manager_id;
      if (nextManagerId != null) nextManagerId = String(nextManagerId);
    }
    return false;
  };

  for (const [index, row] of rows.entries()) {
    const rowNumber = rowNumbers[index];
    if (duplicateRowNumbers.has(rowNumber)) continue;

    const rowErrors = [];
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `employee:${scope.organizationId}:${row.employeeId}`,
    ]);

    const mappedIds = Array.isArray(row.mappedCountryDirectorIds)
      ? row.mappedCountryDirectorIds.map(String).filter(Boolean)
      : String(row.mappedCountryDirectorIds || '').split('|').map(value => value.trim()).filter(Boolean);
    const primaryDirectorId = row.primaryCountryDirectorId || mappedIds[0] || null;
    if (!primaryDirectorId) {
      rowErrors.push({rowNumber, field: 'primaryCountryDirectorId', message: 'Primary country director is required.'});
    }
    if (primaryDirectorId && !directorIds.has(primaryDirectorId)) {
      rowErrors.push({rowNumber, field: 'primaryCountryDirectorId', message: 'Primary country director does not exist.'});
    }
    for (const directorId of mappedIds) {
      if (!directorIds.has(directorId)) {
        rowErrors.push({rowNumber, field: 'mappedCountryDirectorIds', message: 'A mapped country director does not exist.'});
      }
    }

    let reportingManagerId = null;
    if (row.reportingManagerId) {
      const manager = simulatedEmployeesById.get(String(row.reportingManagerId))
        || simulatedEmployeesByCode.get(String(row.reportingManagerId));
      if (!manager || manager.status === 'Exited') {
        rowErrors.push({rowNumber, field: 'reportingManagerId', message: 'Reporting manager employee record does not exist or is exited.'});
      }
      reportingManagerId = manager?.id || null;
    }

    const previous = (await client.query(
      'select * from employees where employee_id = $1 and organization_id = $2 and legal_entity_id = $3 limit 1 for update',
      [row.employeeId, scope.organizationId, scope.legalEntityId],
    )).rows[0];
    if (!previous) {
      const otherLegalEntityEmployee = (await client.query(
        'select id from employees where employee_id = $1 and organization_id = $2 and legal_entity_id is distinct from $3 limit 1 for update',
        [row.employeeId, scope.organizationId, scope.legalEntityId],
      )).rows[0];
      if (otherLegalEntityEmployee) {
        errors.push({rowNumber, field: 'employeeId', message: 'Employee ID is already assigned to another legal entity.', code: 'EMPLOYEE_SCOPE_CONFLICT'});
        invalidSubmittedRows.add(rowNumber);
        continue;
      }
    }

    if (reportingManagerId && (reportingManagerId === previous?.id || row.reportingManagerId === row.employeeId)) {
      rowErrors.push({rowNumber, field: 'reportingManagerId', message: 'Employee cannot report to themselves.'});
    }
    const simulatedEmployeeId = previous?.id || `employee-import-dry-run:${rowNumber}:${row.employeeId}`;
    if (reportingManagerId && createsReportingCycle(reportingManagerId, simulatedEmployeeId)) {
      rowErrors.push({rowNumber, field: 'reportingManagerId', message: 'Reporting manager would create a circular hierarchy.'});
    }

    const emailOwner = (await client.query(
      'select 1 from employees where organization_id = $1 and lower(email) = lower($2) and id is distinct from $3 limit 1',
      [scope.organizationId, row.email, previous?.id || null],
    )).rows[0];
    if (emailOwner) rowErrors.push({rowNumber, field: 'email', message: 'Email is already assigned to another employee.'});

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      invalidSubmittedRows.add(rowNumber);
      continue;
    }

    const targetStatus = row.status || previous?.status || 'Active';
    if (previous && targetStatus === 'Exited') {
      const requestedExitDate = row.exitDate || (previous.status === 'Exited'
        ? undefined
        : new Date().toISOString().slice(0, 10));
      const simulatedDirectReportIds = [...simulatedEmployeesById.values()]
        .filter(employee => String(employee.reporting_manager_id ?? '') === String(previous.id)
          && employee.status !== 'Exited')
        .map(employee => String(employee.id));
      try {
        await assertMayExit(client, previous, scope, requestedExitDate, {simulatedDirectReportIds});
      } catch (error) {
        if (!['WORKER_DEPENDENCY_CONFLICT', 'WORKER_VERSION_CONFLICT'].includes(error.code)) throw error;
        errors.push({rowNumber, field: 'status', message: `${error.message}.`, code: error.code});
        invalidSubmittedRows.add(rowNumber);
        continue;
      }
    }
    if (previous?.status === 'Exited' && targetStatus !== 'Exited') {
      try {
        await assertMayReactivate(client, {
          employeeId: previous.id,
          organizationId: scope.organizationId,
          legalEntityId: scope.legalEntityId,
          effectiveFrom: new Date().toISOString().slice(0, 10),
          status: targetStatus,
        });
      } catch (error) {
        if (error.code !== 'WORKER_VERSION_CONFLICT') throw error;
        errors.push({rowNumber, field: 'status', message: `${error.message}.`, code: error.code});
        invalidSubmittedRows.add(rowNumber);
        continue;
      }
    }

    const existingUser = previous
      ? (await client.query('select id from users where employee_record_id = $1 limit 1', [previous.id])).rows[0]
      : null;
    if (!existingUser && row.initialPasswordPresent !== true) {
      errors.push({rowNumber, field: 'initialPassword', message: 'A new employee account requires an initial password before apply.'});
      invalidSubmittedRows.add(rowNumber);
      continue;
    }

    const employeeSimulation = {
      id: String(simulatedEmployeeId),
      employee_id: row.employeeId,
      status: targetStatus,
      reporting_manager_id: reportingManagerId || previous?.reporting_manager_id || null,
    };
    simulatedEmployeesById.set(employeeSimulation.id, employeeSimulation);
    simulatedEmployeesByCode.set(String(employeeSimulation.employee_id), employeeSimulation);
  }

  return {
    errors,
    validRows: rows.length - invalidSubmittedRows.size,
  };
};

/** Remove submitted values from preview diagnostics before persistence or reply. */
export const safeEmployeeImportDryRunErrors = errors => errors.map(error => ({
  rowNumber: error.rowNumber,
  ...(typeof error.field === 'string' ? {field: error.field} : {}),
  message: error.field === 'initialPassword'
    ? 'A new employee account requires an initial password before apply.'
    : 'The Employee Master row failed validation. Review the row and field before applying.',
  ...(['EMPLOYEE_SCOPE_CONFLICT', 'WORKER_DEPENDENCY_CONFLICT', 'WORKER_VERSION_CONFLICT'].includes(error.code)
    ? {code: error.code}
    : {}),
}));
