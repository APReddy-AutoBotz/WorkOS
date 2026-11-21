insert into permission_definitions(permission_key,module,label,description,protected) values
 ('commercial.retainer_statements.decide','Commercial','Review retainer statements','Independently approve or reject a retained period statement.',false);

-- For existing generations the migration timestamp is a conservative upper bound on the link change.
create table retainer_link_observations(account_id uuid not null,generation bigint not null,observed_at timestamptz not null default clock_timestamp(),
 primary key(account_id,generation), foreign key(account_id,generation) references invoice_reviewer_link_changes(account_id,generation));
create function observe_retainer_link_generation() returns trigger language plpgsql as $$
begin insert into retainer_link_observations(account_id,generation) values(new.account_id,new.generation);return null;end $$;
create trigger observe_retainer_link after insert on invoice_reviewer_link_changes for each row execute function observe_retainer_link_generation();
insert into retainer_link_observations(account_id,generation) select account_id,generation from invoice_reviewer_link_changes;
create trigger immutable_retainer_observation before update or delete on retainer_link_observations for each row execute function reject_commercial_draft_rewrite();
create table retainer_preparer_identities (
 statement_id uuid primary key references commercial_retainer_statements(id),worker_id text not null,generation bigint not null
);
create function retain_retainer_preparer_identity() returns trigger language plpgsql as $$
begin
 perform id from users where id=new.actor_id for share;
 insert into retainer_preparer_identities
 select new.id,u.employee_record_id,coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=u.id),0)
 from users u join employees e on e.id=u.employee_record_id where u.id=new.actor_id
 and e.organization_id=new.organization_id and e.legal_entity_id=new.legal_entity_id and e.status='Active';
 if not found then raise exception 'A current preparer worker is required.' using errcode='RSR01'; end if;
 return null;
end $$;
create trigger record_retainer_preparer after insert on commercial_retainer_statements for each row execute function retain_retainer_preparer_identity();
insert into retainer_preparer_identities
 select s.id,e.id,0 from commercial_retainer_statements s join users u on u.id=s.actor_id join employees e on e.id=u.employee_record_id
 where e.organization_id=s.organization_id and e.legal_entity_id=s.legal_entity_id and e.status='Active'
 and not exists(select 1 from invoice_reviewer_link_changes where account_id=u.id);
create trigger immutable_retainer_preparer before update or delete on retainer_preparer_identities for each row execute function reject_commercial_draft_rewrite();

create table commercial_retainer_reviews (
 id uuid primary key,statement_id uuid not null unique references commercial_retainer_statements(id),
 organization_id text not null,legal_entity_id text not null,actor_id uuid not null references users(id),worker_id text not null,
 active_role text not null,source_hash text not null,decision text not null check(decision in ('Approved','Rejected')),
 reason text not null check(length(trim(reason)) between 3 and 1000),operation_id text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,legal_entity_id) references legal_entities(organization_id,id)
);
create function retainer_preparer_is_current(s commercial_retainer_statements) returns boolean language sql stable as $$
 select exists(select 1 from retainer_preparer_identities w join users u on u.id=s.actor_id and u.employee_record_id=w.worker_id
   join employees e on e.id=w.worker_id where w.statement_id=s.id and u.status='Active' and e.status='Active'
   and e.organization_id=s.organization_id and e.legal_entity_id=s.legal_entity_id and
   w.generation=coalesce((select max(generation) from invoice_reviewer_link_changes where account_id=s.actor_id),0))
$$;
create function guard_retainer_review() returns trigger language plpgsql as $$
declare s commercial_retainer_statements; reviewer text; ctx jsonb;
begin
 select * into s from commercial_retainer_statements where id=new.statement_id and organization_id=new.organization_id and legal_entity_id=new.legal_entity_id;
 if s.id is null or s.source_hash<>new.source_hash or exists(select 1 from commercial_retainer_statements n where
    n.version_id=s.version_id and n.starts_on=s.starts_on and n.sequence>s.sequence) then
   raise exception 'Statement superseded or unavailable.' using errcode='RSR02'; end if;
 perform id from users where id in(s.actor_id,new.actor_id) order by id for share;
 select e.id into reviewer from users u join employees e on e.id=u.employee_record_id where u.id=new.actor_id
   and e.organization_id=s.organization_id and e.legal_entity_id=s.legal_entity_id and e.status='Active' for share of e;
 ctx:=nullif(current_setting('workos.retainer_review',true),'')::jsonb;
 if ctx is distinct from jsonb_build_object('id',new.id,'actor',new.actor_id,'operation',new.operation_id,'statement',s.id,'hash',s.source_hash)
   or reviewer is null or not retainer_preparer_is_current(s) or s.actor_id=new.actor_id
   or exists(select 1 from retainer_preparer_identities where statement_id=s.id and worker_id=reviewer)
   or exists(select 1 from retainer_link_observations where account_id=new.actor_id and observed_at>=s.created_at)
   or exists(select 1 from unnest(array['commercial.retainer_statements.decide','commercial.contracts.view','employees.view','reports.view_utilization','commercial.rate_candidates.view']) k
     where not invoice_notice_actor_has(s.organization_id,s.legal_entity_id,new.actor_id,new.active_role,k))
 then raise exception 'Independent current reviewer required.' using errcode='RSR01'; end if;
 new.worker_id=reviewer;
 return new;
end $$;
create trigger validate_retainer_review before insert on commercial_retainer_reviews for each row execute function guard_retainer_review();
create trigger immutable_retainer_review before update or delete on commercial_retainer_reviews for each row execute function reject_commercial_draft_rewrite();
create function require_retainer_review_audit() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from audit_logs where organization_id=new.organization_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id::text
  and active_role=new.active_role and operation_id=new.operation_id and module='Commercial Drafting' and action=new.decision
  and entity_type='Retainer Statement Review' and entity_id=new.id::text and new_value=jsonb_build_object('statementId',new.statement_id,'sourceHash',new.source_hash,'decision',new.decision))
 then raise exception 'Scoped review audit required.' using errcode='RSR03'; end if;return null;
end $$;
create constraint trigger retainer_review_audit after insert on commercial_retainer_reviews deferrable initially deferred for each row execute function require_retainer_review_audit();
