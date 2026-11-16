// Preserve the existing sign-in qualification rule at every authority boundary.
// SQL aliases are internal identifiers, never caller-supplied values.
export const qualifiedDirectorSql = alias => {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new TypeError('Invalid workforce SQL alias');
  return `case when lower(${alias}.designation) in ('country director','regional lead','director')
    or lower(${alias}.department)='regional leadership'
    then ${alias}.primary_country_director_id else null end`;
};
