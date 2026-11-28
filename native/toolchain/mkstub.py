import sys
for line in open(sys.argv[1]):
    line=line.split('#')[0].split()
    if len(line)<2: continue
    n,t=line[0],line[1]; sz=int(line[2]) if len(line)>2 and line[2].isdigit() else 8
    if t=='FUNC': print('void %s(void){}'%n)
    elif t in('OBJECT','TLS'): print('char %s[%d];'%(n,max(sz,1)))
