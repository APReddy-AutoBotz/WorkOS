import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {ResourcePlanningSignals} from '../../src/pages/PlanningWorkspace';
import {planningService} from '../../src/services/api';
import {normalizeResourcePlanningReport} from '../../src/services/apiClient';

const root = createRoot(document.getElementById('root'));
window.showPlanningReport = report => {
  planningService.getResourcePlanning = async () => normalizeResourcePlanningReport(report);
  root.render(React.createElement(MemoryRouter, null, React.createElement(ResourcePlanningSignals)));
};
