import { GateModel } from './gates.model';

export const gateRepo = {
  list: () => GateModel.find().lean(),
  findById: (id: string) => GateModel.findById(id).lean(),
  findByTypeAndDirection: (type: 'person' | 'vehicle', direction: 'entry' | 'exit') =>
    GateModel.findOne({ type, direction }).lean(),
};
