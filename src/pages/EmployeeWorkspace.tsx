import { ESSHome } from './LeaveManagement';
import {OwnWorkPlanning} from '../components/OwnWorkPlanning';

export const EmployeeWorkspace = () => <ESSHome initialSection="work" workPlanning={<OwnWorkPlanning/>}/>;
